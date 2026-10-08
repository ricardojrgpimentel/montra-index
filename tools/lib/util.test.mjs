// Tests for the shared helpers. Run with: pnpm test
//
// O sítio onde o índice é escrito é uma regra de segurança de publicação, não um
// detalhe: escrever o índice de um build `--only` por cima do publicado deixa o
// catálogo com uma app à espera de que o bot o reconstrua.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { DIRS, indexPathFor } from "./util.mjs";

describe("indexPathFor", () => {
  it("um build completo escreve no índice publicado", () => {
    assert.equal(indexPathFor(), path.join(DIRS.root, "index.json"));
    assert.equal(indexPathFor(null), path.join(DIRS.root, "index.json"));
  });

  it("um build --only escreve no cache, nunca no índice publicado", () => {
    const file = indexPathFor("exemplo");
    assert.notEqual(file, path.join(DIRS.root, "index.json"));
    assert.equal(path.dirname(file), DIRS.cache);
    assert.match(path.basename(file), /exemplo/);
  });

  it("dois builds --only não escrevem um por cima do outro", () => {
    assert.notEqual(indexPathFor("exemplo"), indexPathFor("outra"));
  });
});
