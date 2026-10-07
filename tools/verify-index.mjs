#!/usr/bin/env node
// Verify the published index exactly the way the Android client does.
//
//   node tools/verify-index.mjs                 signature + schema + key id
//   node tools/verify-index.mjs --artifact f-droid --rehash
//                                               also re-download one APK and check its sha256
//   node tools/verify-index.mjs --all --rehash  every artifact (slow; CI nightly)
import { createPublicKey, createVerify, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { DIRS, color, downloadCached, exists, fail, humanBytes, log, sha256File } from "./lib/util.mjs";
import { keyIdFromPublicKeyPem, readPublicKeyPem } from "./lib/keys.mjs";
import { findApkTools, inspectApk } from "./lib/apk.mjs";

export function verifySignature(indexBytes, signature, publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ec") throw new Error("chave pública não é EC");
  const verifier = createVerify("SHA256");
  verifier.update(indexBytes);
  verifier.end();
  return verifier.verify(key, signature);
}

async function main() {
  const args = process.argv.slice(2);
  const rehash = args.includes("--rehash");
  const all = args.includes("--all");
  const artifactIndex = args.indexOf("--artifact");
  const artifactId = artifactIndex >= 0 ? args[artifactIndex + 1] : null;

  const indexPath = path.join(DIRS.out, "index.json");
  const sigPath = path.join(DIRS.out, "index.json.sig");
  if (!(await exists(indexPath)) || !(await exists(sigPath))) {
    fail("index.json e/ou index.json.sig em falta. Corre: node tools/build-index.mjs && node tools/sign-index.mjs");
  }

  const bytes = await fs.readFile(indexPath);
  const signature = Buffer.from((await fs.readFile(sigPath, "utf8")).trim(), "base64");
  const publicPem = await readPublicKeyPem();

  let ok = true;

  // 1. Signature over the raw bytes.
  if (!verifySignature(bytes, signature, publicPem)) {
    log.error("ASSINATURA INVÁLIDA — index.json não corresponde a index.json.sig");
    ok = false;
  } else {
    log.ok("assinatura válida (ECDSA P-256 / SHA-256)");
  }

  const index = JSON.parse(bytes.toString("utf8"));

  // 2. Key id: catches a rotation that the client would refuse.
  const expectedKeyId = keyIdFromPublicKeyPem(publicPem);
  if (index.signingKeyId && index.signingKeyId !== expectedKeyId) {
    log.error(`key id não bate certo: index diz ${index.signingKeyId}, chave é ${expectedKeyId}`);
    ok = false;
  } else if (index.signingKeyId) {
    log.ok(`key id confirmado (${expectedKeyId})`);
  }

  // 3. Schema.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(await fs.readFile(path.join(DIRS.schema, "index.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(index)) {
    log.error("index.json não valida contra index.schema.json:");
    for (const err of validate.errors ?? []) log.error(`  ${err.instancePath || "/"} ${err.message}`);
    ok = false;
  } else {
    log.ok(`schema válido (${index.apps.length} apps)`);
  }

  // 4. Client-side sanity rules that the app also enforces.
  for (const app of index.apps) {
    if (!app.artifact?.sha256 || app.artifact.sha256.length !== 64) {
      log.error(`${app.id}: artifact sem sha256 válido — a app recusaria instalar`);
      ok = false;
    }
    if (app.signingCertSha256 === null || app.signingCertSha256 === undefined) {
      log.warn(`${app.id}: sem fingerprint de certificado (apksigner indisponível?)`);
    }
  }

  // 5. Optional: re-download and re-hash.
  const targets = all
    ? index.apps
    : artifactId
      ? index.apps.filter((a) => a.id === artifactId)
      : [];
  if (artifactId && targets.length === 0) fail(`app não encontrada no índice: ${artifactId}`);

  if (rehash && targets.length) {
    const tools = await findApkTools({ required: false }).catch(() => ({}));
    for (const app of targets) {
      for (const asset of app.release?.assets ?? []) {
        process.stdout.write(`  ${color.dim("rehash")} ${app.id} [${asset.abi}] … `);
        const file = await downloadCached(asset.url, { subdir: "verify" });
        const digest = await sha256File(file);
        const size = (await fs.stat(file)).size;
        if (digest !== asset.sha256) {
          console.log(color.red("FALHOU"));
          log.error(`  esperado ${asset.sha256}\n  obtido   ${digest}`);
          ok = false;
          continue;
        }
        let extra = `${humanBytes(size)}`;
        if (tools.aapt2) {
          const info = await inspectApk(file, { tools });
          if (asset.signingCertSha256 && info.signingCertSha256 && asset.signingCertSha256 !== info.signingCertSha256) {
            console.log(color.red("CERT DIFERENTE"));
            log.error(`  index  ${asset.signingCertSha256}\n  no APK ${info.signingCertSha256}`);
            ok = false;
            continue;
          }
          extra += `, v${info.versionName} (${info.versionCode}), cert ok`;
        }
        console.log(color.green("ok ") + color.dim(extra));
      }
    }
  }

  if (!ok) fail("verificação do índice falhou");
  log.ok("índice verificado: um cliente que confie nesta chave pode instalar a partir dele");
}

await main();
