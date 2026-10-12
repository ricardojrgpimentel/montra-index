// Tests da re-codificação das capturas. Tudo corre sem rede: as imagens são
// construídas aqui (o PNG com o zlib do node) e a conversão real só corre quando
// há um cwebp ou um ImageMagick instalado — nos outros casos é saltada, em vez de
// fingir que passou.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import {
  filesToRemove, findImageTools, imageDimensions, imageExtension, mediaBudgetWarning, toIndexImage,
} from "./images.mjs";

/* --------------------------------------------------------- PNG de brinquedo */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG válido de uma cor só: chega para o cwebp e para medir o cabeçalho. */
function solidPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profundidade de 8 bits
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filtro "none"
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = 0x20;
      raw[row + 2 + x * 3] = 0x60;
      raw[row + 3 + x * 3] = 0xa0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const riff = (fourcc, body) => {
  const buffer = Buffer.alloc(20 + body.length);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write(fourcc, 12, "latin1");
  buffer.writeUInt32LE(body.length, 16);
  body.copy(buffer, 20);
  return buffer;
};

describe("imageExtension", () => {
  it("reconhece o formato pelos bytes, não pela extensão", () => {
    assert.equal(imageExtension(solidPng(2, 2)), "png");
    assert.equal(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
    assert.equal(imageExtension(Buffer.from("GIF89a....", "latin1")), "gif");
    assert.equal(imageExtension(riff("VP8X", Buffer.alloc(10))), "webp");
    assert.equal(imageExtension(Buffer.from("<svg xmlns=...")), "svg");
    assert.equal(imageExtension(Buffer.from("nao e imagem")), null);
  });
});

describe("imageDimensions", () => {
  it("lê um PNG", () => {
    assert.deepEqual(imageDimensions(solidPng(1600, 900)), { width: 1600, height: 900 });
  });

  it("lê um JPEG a partir do primeiro SOF", () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x05, 0x00, 0x03]),
      Buffer.alloc(8),
    ]);
    assert.deepEqual(imageDimensions(jpeg), { width: 1280, height: 640 });
  });

  it("lê um GIF", () => {
    const gif = Buffer.alloc(16);
    gif.write("GIF89a", 0, "latin1");
    gif.writeUInt16LE(331, 6);
    gif.writeUInt16LE(700, 8);
    assert.deepEqual(imageDimensions(gif), { width: 331, height: 700 });
  });

  it("lê as três variantes de WebP", () => {
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(1199, 4, 3); // largura 1200
    vp8x.writeUIntLE(2399, 7, 3); // altura 2400
    assert.deepEqual(imageDimensions(riff("VP8X", vp8x)), { width: 1200, height: 2400 });

    const vp8 = Buffer.alloc(10);
    vp8[3] = 0x9d;
    vp8[4] = 0x01;
    vp8[5] = 0x2a;
    vp8.writeUInt16LE(1080, 6);
    vp8.writeUInt16LE(1920, 8);
    assert.deepEqual(imageDimensions(riff("VP8 ", vp8)), { width: 1080, height: 1920 });

    // VP8L guarda largura-1 e altura-1 em 14 bits cada.
    const bits = Buffer.alloc(10);
    bits[0] = 0x2f;
    bits.writeUInt32LE((539 & 0x3fff) | ((959 & 0x3fff) << 14), 1);
    assert.deepEqual(imageDimensions(riff("VP8L", bits)), { width: 540, height: 960 });
  });

  it("não inventa medidas para o que não conhece", () => {
    assert.equal(imageDimensions(Buffer.from("nao e imagem")), null);
    assert.equal(imageDimensions(Buffer.alloc(0)), null);
  });
});

describe("toIndexImage", () => {
  it("não mexe no GIF: pode ser animado e o cwebp guardaria só um fotograma", async () => {
    const gif = Buffer.from("GIF89a............", "latin1");
    const out = await toIndexImage(gif, { ext: "gif", tools: { converter: { kind: "cwebp", bin: "/nao/existe" } } });
    assert.equal(out.converted, false);
    assert.equal(out.reason, "gif");
    assert.equal(out.buffer, gif);
  });

  it("sem conversor devolve os bytes de origem, sem os disfarçar de WebP", async () => {
    const png = solidPng(4, 4);
    const out = await toIndexImage(png, { ext: "png", tools: { converter: null } });
    assert.equal(out.converted, false);
    assert.equal(out.reason, "sem-conversor");
    assert.equal(out.ext, "png");
    assert.equal(out.buffer, png);
  });

  it("uma ferramenta que rebenta não perde a imagem", async () => {
    const png = solidPng(4, 4);
    const out = await toIndexImage(png, { ext: "png", tools: { converter: { kind: "cwebp", bin: "/nao/existe" } } });
    assert.equal(out.converted, false);
    assert.equal(out.reason, "falhou");
    assert.equal(out.buffer, png);
  });
});

const imageTools = await findImageTools();
const semConversor = imageTools.converter ? false : "sem cwebp nem ImageMagick instalados";

describe("toIndexImage (conversão real)", { skip: semConversor }, () => {
  it("converte para WebP e reduz ao teto de 1080 px", async () => {
    const out = await toIndexImage(solidPng(1600, 900), { ext: "png", tools: imageTools });
    assert.equal(out.converted, true);
    assert.equal(out.ext, "webp");
    assert.equal(imageExtension(out.buffer), "webp");
    assert.equal(out.resized, true);
    assert.equal(imageDimensions(out.buffer).width, 1080);
    assert.equal(imageDimensions(out.buffer).height, 608);
  });

  it("não amplia uma captura mais pequena do que o teto", async () => {
    const out = await toIndexImage(solidPng(400, 300), { ext: "png", tools: imageTools });
    assert.equal(out.converted, true);
    assert.equal(out.resized, false);
    assert.deepEqual(imageDimensions(out.buffer), { width: 400, height: 300 });
  });
});

describe("filesToRemove", () => {
  it("aponta só o que já não é referido", () => {
    assert.deepEqual(filesToRemove(["1.png", "2.webp", "3.png"], ["1.webp", "2.webp"]), ["1.png", "3.png"]);
    assert.deepEqual(filesToRemove([], ["1.webp"]), []);
  });
});

describe("mediaBudgetWarning", () => {
  it("cala-se dentro do orçamento", () => {
    assert.equal(mediaBudgetWarning(24 * 1024 * 1024), null);
    assert.equal(mediaBudgetWarning(1024), null);
  });

  it("avisa acima do orçamento, com os dois números", () => {
    const warning = mediaBudgetWarning(69 * 1024 * 1024);
    assert.match(warning, /acima do orçamento/);
    assert.match(warning, /69 MB/);
    assert.match(warning, /24 MB/);
    assert.match(warning, /aviso, não uma falha/);
  });
});
