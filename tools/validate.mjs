#!/usr/bin/env node
// Validate every app entry in apps/ against schema/app.schema.json plus the
// cross-entry rules that a schema cannot express (unique package names, id
// matching the file name, release config sanity). This is what CI runs on every
// pull request, so a bad contribution fails before it can reach a user's phone.
import { catalogueTextErrors } from "./lib/catalogue-text.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { DIRS, color, exists, log } from "./lib/util.mjs";

const errors = [];
const warnings = [];
const error = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

async function loadSchema(name) {
  return JSON.parse(await fs.readFile(path.join(DIRS.schema, name), "utf8"));
}

function formatAjvErrors(errors_) {
  return (errors_ ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

async function main() {
  const appSchema = await loadSchema("app.schema.json");
  const validateApp = ajv.compile(appSchema);

  // A lista de licenças livres vem do schema: uma só fonte de verdade, sem uma
  // regex duplicada aqui que se desatualiza em silêncio.
  const freeLicenses = new Set(appSchema.properties.license.oneOf[0].enum);

  let files = [];
  try {
    files = (await fs.readdir(DIRS.apps)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    log.error("apps/ não existe");
    process.exit(1);
  }

  if (files.length === 0) {
    log.error("apps/ está vazio");
    process.exit(1);
  }

  const seenPackages = new Map();
  const entries = [];

  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    const full = path.join(DIRS.apps, file);
    let entry;
    try {
      entry = JSON.parse(await fs.readFile(full, "utf8"));
    } catch (e) {
      error(id, `JSON inválido: ${e.message}`);
      continue;
    }

    if (!validateApp(entry)) {
      for (const msg of formatAjvErrors(validateApp.errors)) error(id, `schema: ${msg}`);
      continue;
    }

    for (const msg of catalogueTextErrors(entry)) error(id, msg);

    // --- rules the schema cannot express -----------------------------------
    if (entry.id !== id) error(id, `campo "id" ("${entry.id}") tem de ser igual ao nome do ficheiro ("${id}")`);

    if (seenPackages.has(entry.packageName)) {
      error(id, `packageName duplicado: já usado por "${seenPackages.get(entry.packageName)}"`);
    } else {
      seenPackages.set(entry.packageName, id);
    }

    // Licença restritiva: aceite, mas nunca em silêncio. Três coisas ao mesmo
    // tempo, ou o build falha — foi assim que se decidiu incluir software com
    // licenças estranhas sem transformar "só software livre" numa frase falsa.
    if (!freeLicenses.has(entry.license)) {
      if (!entry.antiFeatures?.includes("restrictedLicense")) {
        error(
          id,
          `license "${entry.license}" não é uma licença livre, portanto antiFeatures tem de incluir "restrictedLicense"`,
        );
      }
      if (!entry.licenseNote?.en) {
        error(
          id,
          `license "${entry.license}" é restritiva, portanto licenseNote.en é obrigatório ` +
            "e tem de explicar, em linguagem simples, o que a licença não permite",
        );
      }
      if (!entry.notes) {
        warn(id, "uma entrada com licença restritiva deve explicar em notes porque foi aceite");
      }
    } else if (entry.licenseNote) {
      warn(id, "licenseNote só faz sentido com uma licença restritiva (LicenseRef-*)");
    }

    const rel = entry.release;
    if (rel.provider === "github" || rel.provider === "gitlab") {
      if (!rel.repo) error(id, `release.provider=${rel.provider} exige release.repo`);
      if (rel.url) warn(id, "release.url é ignorado quando provider é github/gitlab");
      if (rel.repo && entry.sourceCode && !entry.sourceCode.toLowerCase().includes(rel.repo.toLowerCase())) {
        warn(id, `release.repo (${rel.repo}) não aparece em sourceCode — confirma que é o mesmo projeto`);
      }
    }
    if (rel.provider === "direct" && !rel.url) error(id, "release.provider=direct exige release.url");
    if (rel.provider === "fdroid" && !rel.fdroidRepo) error(id, "release.provider=fdroid exige release.fdroidRepo");

    const abiKeys = Object.keys(rel.abiAssets ?? {});
    if (abiKeys.length && !rel.abiAssets.universal) {
      warn(id, "abiAssets sem entrada 'universal': dispositivos sem ABI correspondente não terão download");
    }

    if (entry.status === "deprecated" && !entry.notes) {
      warn(id, "status=deprecated sem notes: explica aos utilizadores o que usar em vez disso");
    }

    if (!entry.categories?.length) warn(id, "sem categories: a app só aparece em 'Todas'");
    if (!entry.icon) warn(id, "sem icon: o cliente vai desenhar um monograma");
    if (!entry.verification?.signingCertSha256) {
      warn(id, "sem verification.signingCertSha256: o fingerprint será fixado na primeira build que o resolver");
    }

    entries.push(entry);
  }

  // Parentesco: um appId tem de existir, senão o cliente mostra uma ligação morta.
  const ids = new Set(entries.map((e) => e.id));
  for (const entry of entries) {
    if (!entry.forkOf?.appId) continue;
    if (!ids.has(entry.forkOf.appId)) {
      error(entry.id, `forkOf.appId "${entry.forkOf.appId}" não existe em apps/`);
    }
    if (entry.forkOf.appId === entry.id) {
      error(entry.id, "forkOf.appId aponta para a própria entrada");
    }
  }

  // --- optional: also check the generated index ----------------------------
  const indexPath = path.join(DIRS.out, "index.json");
  let indexSummary = null;
  if (await exists(indexPath)) {
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    const validateIndex = ajv.compile(await loadSchema("index.schema.json"));
    if (!validateIndex(index)) {
      for (const msg of formatAjvErrors(validateIndex.errors)) error("index.json", `schema: ${msg}`);
    } else {
      indexSummary = index;
    }

    if (indexSummary) {
      const byId = new Map(entries.map((e) => [e.id, e]));
      for (const app of indexSummary.apps) {
        const source = byId.get(app.id);
        if (!source) {
          error("index.json", `contém "${app.id}" que já não existe em apps/ — corre tools/build-index.mjs`);
          continue;
        }
        // The pin in apps/<id>.json is the trust anchor; a build that produced a
        // different certificate must fail loudly, not silently re-pin.
        const pinned = source.verification?.signingCertSha256;
        if (pinned && app.signingCertSha256 && pinned.toLowerCase() !== app.signingCertSha256.toLowerCase()) {
          error(
            app.id,
            `certificado de assinatura mudou!\n    fixado em apps/${app.id}.json: ${pinned}\n    no APK publicado:              ${app.signingCertSha256}\n` +
              "    Se a app mudou de chave de assinatura de forma legítima, atualiza o pin conscientemente; caso contrário, isto é um release comprometido.",
          );
        }
        // Uma licença restritiva sem nota no índice é uma restrição escondida.
        if (!freeLicenses.has(app.license) && !app.licenseNote?.en) {
          error(
            app.id,
            `o índice publicado tem license "${app.license}" mas não leva licenseNote: ` +
              "a app mostraria um aviso genérico em vez da nota do autor (corre tools/build-index.mjs)",
          );
        }
        if (!pinned && app.signingCertSha256) {
          warn(app.id, "sem pin de certificado em apps/*.json — corre: node tools/build-index.mjs --update-pins");
        }
      }
    }
  } else {
    warn("index.json", "não existe (normal antes da primeira build)");
  }

  // --- report --------------------------------------------------------------
  console.log("");
  const nameWidth = Math.max(14, ...entries.map((e) => (e.name ?? "").length)) + 2;
  for (const e of entries) {
    const rel = indexSummary?.apps.find((a) => a.id === e.id);
    const version = rel?.release?.versionName ?? color.dim("—");
    const abis = rel ? rel.release.assets.map((a) => a.abi.replace("universal", "all")).join(",") : "";
    const status = e.status && e.status !== "active" ? color.yellow(` [${e.status}]`) : "";
    console.log(
      `  ${color.bold((e.name ?? "").padEnd(nameWidth))}${version.padEnd(18)}${color.dim(abis.padEnd(22))}${color.dim(e.packageName)}${status}`,
    );
  }
  console.log("");

  for (const w of warnings) log.warn(w);

  if (errors.length) {
    console.log("");
    for (const e of errors) log.error(e);
    console.log("");
    log.error(`${errors.length} erro(s) em ${files.length} ficheiro(s)`);
    process.exit(1);
  }

  log.ok(`${entries.length} apps válidas${warnings.length ? `, ${warnings.length} aviso(s)` : ""}`);
}

await main();
