// Imagens re-alojadas: reconhecer o formato, medir, e re-codificar para WebP.
//
// As capturas de ecrã são o que faz doer um clone do repositório: 149 imagens,
// 66 MB em git. O cliente já aceita WebP (há um ícone e três capturas em WebP no
// catálogo), portanto guardar WebP não muda o contrato com o cliente — muda o
// peso de quem clona.
//
// Não se acrescentou uma dependência npm para isto: o `cwebp` da libwebp é o
// codificador de referência, está em `apt install webp` e no homebrew, e o
// ImageMagick serve de alternativa. Se nenhum estiver instalado, o build avisa e
// guarda o formato de origem; inventar uma conversão que não aconteceu seria pior
// do que assumir a falta da ferramenta.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { humanBytes, log } from "./util.mjs";

const execFileAsync = promisify(execFile);

/**
 * 1080 px de largura máxima.
 *
 * É a largura de 87 das 149 capturas do catálogo — o valor que os próprios
 * autores publicam para telefone. Acima disto o cliente encolhe a imagem para o
 * ecrã de qualquer maneira, e o que fica em git é peso que ninguém vê: das
 * capturas maiores, as de 2160 px e 2400 px caem para 1080 sem perda visível na
 * ficha da app.
 */
export const WEBP_MAX_WIDTH = 1080;

/**
 * Qualidade 82.
 *
 * O cwebp usa 75 por omissão. Capturas de interface são sobretudo texto e
 * gradientes, onde os artefactos de blocos se notam a ler; a 82 o catálogo
 * inteiro mediu 10,9 MB (contra 66,1 MB de origem) e a diferença para 75 era
 * poupança de ~1 MB — não vale a legibilidade.
 */
export const WEBP_QUALITY = 82;

/**
 * Orçamento de icons/ + screenshots/ em git: 24 MB.
 *
 * Só o que o build escreve no repositório conta: os APKs vivem no cache e o
 * index.json são 370 KB. Medido com a re-codificação: 10,9 MB de capturas + 3,0 MB
 * de ícones = ~14 MB para 81 apps, o que deixa margem para o catálogo crescer sem
 * que um clone deixe de ser razoável. Hoje, sem re-codificar, o total é 69 MB — o
 * aviso dispara até a próxima reconstrução passar tudo por WebP.
 */
export const MEDIA_BUDGET_BYTES = 24 * 1024 * 1024;

/* ------------------------------------------------------------ tipo e tamanho */
const IMAGE_MAGIC = [
  { ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "gif", test: (b) => b.subarray(0, 3).toString("latin1") === "GIF" },
];

/** O formato real dos bytes, não o que a extensão do URL diz. */
export function imageExtension(buffer) {
  for (const { ext, test } of IMAGE_MAGIC) if (test(buffer)) return ext;
  const head = buffer.subarray(0, 200).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "svg";
  return null;
}

/**
 * Largura e altura, lidas do cabeçalho.
 *
 * Necessário porque o cwebp `-resize` também amplia: uma captura de 331 px ia para
 * 1080 e crescia de 50 KB para 143 KB. Só se reduz o que é maior do que o teto.
 */
export function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;

  if (buffer[0] === 0x89 && buffer.toString("latin1", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  const gif = buffer.toString("latin1", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  if (buffer.length >= 30 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buffer.toString("latin1", 12, 16);
    // VP8X: 3 bytes little-endian com a largura (e a altura) menos um.
    if (chunk === "VP8X") return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    // VP8 (com perdas): 14 bits de largura e 14 de altura depois do código de arranque.
    if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    // VP8L (sem perdas): os mesmos 14+14 bits, a seguir ao byte de assinatura 0x2f.
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buffer[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const length = buffer.readUInt16BE(i + 2);
      if (length < 2) return null;
      // SOF0..SOF15, exceto os marcadores que não são imagens (DHT, JPG, DAC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
      }
      if (marker === 0xda) break;
      i += 2 + length;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- conversores */
let toolsCache;

/**
 * `cwebp` primeiro, ImageMagick depois. Procurar nas duas coisas em vez de exigir
 * uma: o CI tem o `webp` do apt, um portátil pode ter só o ImageMagick, e a
 * escolha do codificador não muda o contrato do índice.
 */
export async function findImageTools() {
  if (toolsCache) return toolsCache;
  const which = async (name) => {
    try {
      const { stdout } = await execFileAsync("which", [name], { timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const cwebp = process.env.CWEBP || (await which("cwebp"));
  const magick = process.env.MAGICK || (await which("magick")) || (await which("convert"));
  toolsCache = {
    cwebp,
    magick,
    converter: cwebp ? { kind: "cwebp", bin: cwebp } : magick ? { kind: "magick", bin: magick } : null,
  };
  return toolsCache;
}

/**
 * Re-codifica bytes de imagem para WebP, com teto de largura.
 *
 * Devolve null quando não há conversor, quando o formato não é reconhecido ou
 * quando a ferramenta falha: quem chama decide o que fazer com a imagem original.
 */
export async function reencodeWebp(buffer, { tools = null, maxWidth = WEBP_MAX_WIDTH, quality = WEBP_QUALITY } = {}) {
  const converter = tools?.converter ?? null;
  const dims = imageDimensions(buffer);
  if (!converter || !dims) return null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "montra-webp-"));
  const input = path.join(dir, "in.img");
  const output = path.join(dir, "out.webp");
  try {
    await fs.writeFile(input, buffer);
    const args =
      converter.kind === "cwebp"
        ? [
            "-quiet",
            "-q",
            String(quality),
            // Só reduzir: o `-resize` do cwebp também amplia.
            ...(dims.width > maxWidth ? ["-resize", String(maxWidth), "0"] : []),
            input,
            "-o",
            output,
          ]
        : // `1080x>` com o ImageMagick reduz só o que é maior. -strip tira os
          // metadados: não servem para nada na ficha da app e são peso.
          [input, "-strip", "-resize", `${maxWidth}x>`, "-quality", String(quality), "-define", "webp:method=6", output];
    await execFileAsync(converter.bin, args, { maxBuffer: 8 * 1024 * 1024 });
    const encoded = await fs.readFile(output);
    if (!encoded.length) return null;
    const final = imageDimensions(encoded);
    return {
      buffer: encoded,
      width: final?.width ?? null,
      height: final?.height ?? null,
      resized: dims.width > maxWidth,
    };
  } catch (error) {
    log.warn(`conversão para WebP falhou (${converter.kind}): ${String(error.message).split("\n")[0]}`);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * O que guardar em git para uma imagem do upstream.
 *
 * O GIF fica de fora da conversão: pode ser animado e o cwebp guardaria só o
 * primeiro fotograma, sem avisar. Um GIF parado perde pouco por não ser WebP.
 */
export async function toIndexImage(buffer, { ext, tools = null, maxWidth = WEBP_MAX_WIDTH, quality = WEBP_QUALITY } = {}) {
  if (ext === "gif") return { buffer, ext, converted: false, reason: "gif" };
  const encoded = await reencodeWebp(buffer, { tools, maxWidth, quality });
  if (!encoded) return { buffer, ext, converted: false, reason: tools?.converter ? "falhou" : "sem-conversor" };
  return { buffer: encoded.buffer, ext: "webp", converted: true, resized: encoded.resized };
}

/* ------------------------------------------------------------------ ficheiros */
/** Nomes de ficheiros existentes que já não são referidos (para apagar). */
export function filesToRemove(existing, keep) {
  const keepSet = new Set(keep);
  return existing.filter((name) => !keepSet.has(name));
}

export async function directorySize(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}

/** Aviso quando o que o git guarda por app passa o orçamento, ou null. */
export function mediaBudgetWarning(totalBytes, budget = MEDIA_BUDGET_BYTES) {
  if (totalBytes <= budget) return null;
  return (
    `icons/ + screenshots/ ocupam ${humanBytes(totalBytes)}, acima do orçamento de ${humanBytes(budget)}. ` +
    "As capturas novas são re-codificadas para WebP até " +
    `${WEBP_MAX_WIDTH} px, mas ficheiros antigos (noutro formato, ou de apps cujas capturas mudaram) ` +
    "só saem com um build que os volte a escrever. Isto é um aviso, não uma falha: a decisão de onde cortar é humana."
  );
}
