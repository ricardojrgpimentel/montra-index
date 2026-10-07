#!/usr/bin/env node
// Sign index.json -> index.json.sig
//
//   INDEX_SIGNING_KEY="$(cat keys/index-signing.key.pem)" node tools/sign-index.mjs
//
// The signature covers the exact bytes of index.json as they will be served, so
// the client can hash what it downloaded and verify it without any JSON
// re-serialisation ambiguity.
import { createPrivateKey, createSign, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DIRS, color, exists, fail, log } from "./lib/util.mjs";
import { keyIdFromPublicKeyPem, readPrivateKeyPem, readPublicKeyPem } from "./lib/keys.mjs";

const INDEX_PATH = path.join(DIRS.out, "index.json");
const SIG_PATH = path.join(DIRS.out, "index.json.sig");
async function main() {
  if (!(await exists(INDEX_PATH))) fail("index.json não existe. Corre primeiro: node tools/build-index.mjs");

  const pem = await readPrivateKeyPem();
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ec") {
    fail(`a chave de assinatura tem de ser EC P-256, recebi ${privateKey.asymmetricKeyType}`);
  }

  const bytes = await fs.readFile(INDEX_PATH);
  const signature = createSign("SHA256").update(bytes).sign(privateKey);
  await fs.writeFile(SIG_PATH, signature.toString("base64") + "\n", "utf8");

  const publicPem = await readPublicKeyPem();
  const keyId = keyIdFromPublicKeyPem(publicPem);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  log.ok(`assinado index.json (${bytes.length} bytes)`);
  log.info(`  sha256  ${sha256}`);
  log.info(`  key id  ${keyId}`);
  log.info(`  output  ${SIG_PATH}`);
  console.log(color.dim("\nPublica index.json, index.json.sig, icons/ e screenshots/ no mesmo commit.\n"));
}

await main();
