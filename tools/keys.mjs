#!/usr/bin/env node
// Index signing key management.
//
//   node tools/keys.mjs init      generate keys/index-signing.key.pem (private) + .pub.pem
//   node tools/keys.mjs show      print the public key and its key id
//
// The private key NEVER goes into git (see .gitignore) and lives in CI as the
// INDEX_SIGNING_KEY secret. The public key is committed and is embedded in the app:
// that is the only thing standing between a compromised mirror and a malicious app
// being installed on a user's phone.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import { color, exists, fail, log } from "./lib/util.mjs";
import { PRIVATE_KEY_PATH, PUBLIC_KEY_PATH, keyIdFromPublicKeyPem, readPublicKeyPem } from "./lib/keys.mjs";

async function init() {
  const publicPem = await (async () => {
    if (await exists(PRIVATE_KEY_PATH)) {
      const pem = await fs.readFile(PRIVATE_KEY_PATH, "utf8");
      log.warn(`chave privada já existe (${PRIVATE_KEY_PATH}) — não foi tocada`);
      return createPublicKey(pem).export({ type: "spki", format: "pem" });
    }
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      // P-256: java.security has supported SHA256withECDSA since forever, so the
      // client needs no crypto dependency at all.
      namedCurve: "prime256v1",
    });
    await fs.mkdir(new URL("../keys/", import.meta.url).pathname, { recursive: true }).catch(() => {});
    await fs.writeFile(PRIVATE_KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    log.ok(`chave privada criada: ${PRIVATE_KEY_PATH} (0600, ignorada pelo git)`);
    return publicKey.export({ type: "spki", format: "pem" });
  })();

  await fs.writeFile(PUBLIC_KEY_PATH, publicPem, "utf8");
  log.ok(`chave pública gravada: ${PUBLIC_KEY_PATH}`);
  log.info(`key id: ${color.bold(keyIdFromPublicKeyPem(publicPem))}`);
  console.log(
    `\n${color.bold("CI:")} guarda o conteúdo do ficheiro privado no secret ${color.cyan("INDEX_SIGNING_KEY")}\n` +
      `${color.bold("App:")} copia keys/index-signing.pub.pem para android/app/src/main/assets/\n` +
      `${color.bold("Segurança:")} faz cópia de segurança offline. Se a perderes, todos os clientes\n` +
      `instalados deixam de aceitar índices novos até sair uma versão com uma chave nova.\n`,
  );
}

async function show() {
  const pem = await readPublicKeyPem();
  console.log(pem.trim());
  console.log(`\nkey id: ${color.bold(keyIdFromPublicKeyPem(pem))}`);
}

const command = process.argv[2] ?? "show";
if (command === "init") await init();
else if (command === "show") await show();
else fail(`comando desconhecido: ${command} (usa: init | show)`);
