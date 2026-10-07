// Tests for the signing-key identity helpers. Run with: pnpm test
//
// A chave privada não existe no CI (vive num secret), portanto estes testes nunca
// lhe tocam: geram pares descartáveis próprios. O que se testa aqui é a única
// pergunta que interessa no dia de restaurar um backup — "esta chave é a que as
// apps instaladas conhecem?" — e os formatos de PEM que a resposta deve recusar.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { keyIdFromPrivateKeyPem, keyIdFromPublicKeyPem } from "./keys.mjs";

const newPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicPem: publicKey.export({ type: "spki", format: "pem" }),
  };
};

describe("keyIdFromPrivateKeyPem", () => {
  it("dá o mesmo id que a pública derivada dela", () => {
    const { privatePem, publicPem } = newPair();
    assert.equal(keyIdFromPrivateKeyPem(privatePem), keyIdFromPublicKeyPem(publicPem));
  });

  it("distingue chaves diferentes", () => {
    // Se isto falhasse, o `check` diria que sim a qualquer chave e não servia de nada.
    const a = newPair();
    const b = newPair();
    assert.notEqual(keyIdFromPrivateKeyPem(a.privatePem), keyIdFromPrivateKeyPem(b.privatePem));
  });

  it("não confunde uma privada com a pública de outro par", () => {
    const a = newPair();
    const b = newPair();
    assert.notEqual(keyIdFromPrivateKeyPem(a.privatePem), keyIdFromPublicKeyPem(b.publicPem));
  });

  it("tolera CRLF, newline a menos, linhas em branco e espaços no fim das linhas", () => {
    // Um gestor de palavras-passe ou uma colagem podem fazer isto. Não estraga nada:
    // o descodificador ignora o ruído à volta e no fim das linhas.
    const { privatePem, publicPem } = newPair();
    const expected = keyIdFromPublicKeyPem(publicPem);
    assert.equal(keyIdFromPrivateKeyPem(privatePem.replace(/\n/g, "\r\n")), expected);
    assert.equal(keyIdFromPrivateKeyPem(privatePem.replace(/\n$/, "")), expected);
    assert.equal(keyIdFromPrivateKeyPem(`\n\n${privatePem}\n\n`), expected);
    assert.equal(keyIdFromPrivateKeyPem(privatePem.replace(/\n/g, " \n")), expected);
    assert.equal(keyIdFromPrivateKeyPem(privatePem.replace(/\n/g, "\t\n")), expected);
  });

  it("recusa um PEM indentado", () => {
    // O que parte o PEM não são os espaços no fim das linhas: é a linha BEGIN deixar
    // de começar na coluna 0. Acontece quando algo reindenta o texto — um editor, um
    // bloco de código, um campo de formulário que alinha o conteúdo.
    const { privatePem } = newPair();
    const indentado = privatePem.split("\n").map((linha) => `  ${linha}`).join("\n");
    assert.throws(() => keyIdFromPrivateKeyPem(indentado));
  });

  it("recusa um PEM todo numa linha só", () => {
    const { privatePem } = newPair();
    assert.throws(() => keyIdFromPrivateKeyPem(privatePem.replace(/\n/g, "")));
  });
});
