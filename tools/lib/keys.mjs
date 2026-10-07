// Index signing keys: the library half. tools/keys.mjs is the CLI on top of this,
// because importing a module must never run a command.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DIRS, exists, fail } from "./util.mjs";

export const PRIVATE_KEY_PATH = path.join(DIRS.keys, "index-signing.key.pem");
export const PUBLIC_KEY_PATH = path.join(DIRS.keys, "index-signing.pub.pem");

/** Short, stable identifier of a signing key: sha256(SPKI) truncated to 16 bytes. */
export function keyIdFromPublicKeyPem(pem) {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 32);
}

/**
 * O key id que uma chave privada produz — derivando a pública a partir dela.
 *
 * Existe para o dia em que alguém restaura a chave de um backup, ou põe o secret
 * errado no CI, e precisa de saber se aquilo é a chave que as apps instaladas
 * conhecem. É a diferença entre descobrir isso em dois segundos ou depois de
 * assinar um índice que ninguém vai aceitar.
 */
export function keyIdFromPrivateKeyPem(pem) {
  const publicPem = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "pem" });
  return keyIdFromPublicKeyPem(publicPem);
}

export async function readPublicKeyPem() {
  if (!(await exists(PUBLIC_KEY_PATH))) {
    fail(`chave pública em falta: ${PUBLIC_KEY_PATH}. Corre: node tools/keys.mjs init`);
  }
  return fs.readFile(PUBLIC_KEY_PATH, "utf8");
}

export async function readPrivateKeyPem() {
  if (process.env.INDEX_SIGNING_KEY) return process.env.INDEX_SIGNING_KEY;
  if (await exists(PRIVATE_KEY_PATH)) return fs.readFile(PRIVATE_KEY_PATH, "utf8");
  fail("sem chave privada. Define INDEX_SIGNING_KEY (CI) ou corre: node tools/keys.mjs init");
}
