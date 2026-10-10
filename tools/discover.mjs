#!/usr/bin/env node
// Find apps worth adding to the catalogue.
//
// This is the tool for the original problem: good open source Android apps exist
// on GitHub, and finding the ones that (a) still ship an APK, (b) are still
// maintained, (c) have a free licence and (d) are *not* on the Play Store is
// tedious manual work. This does that work and prints a report.
//
//   node tools/discover.mjs                              built-in searches
//   node tools/discover.mjs --query "topic:fdroid"       extra GitHub query
//   node tools/discover.mjs --seed owner/repo,owner/repo check specific repos
//   node tools/discover.mjs --inspect --limit 5          download one APK per
//                                                        candidate to learn its
//                                                        real package name and
//                                                        check the Play Store
//   node tools/discover.mjs --inspect --write --limit 5  also write draft
//                                                        apps/<id>.json entries
//   --output report.json --summary summary.md          save reports outside the
//                                                        tracked catalogue (CI)
//
// Nothing is committed automatically: a candidate that passes is a *draft* for a
// human to review, because curation is the product.
import fs from "node:fs/promises";
import path from "node:path";
import {
  DIRS, color, downloadCached, globMatch, humanBytes, log, mapPool, writeJson,
} from "./lib/util.mjs";
import { githubApi, githubToken } from "./lib/github.mjs";
import { findApkTools, inspectApk } from "./lib/apk.mjs";
import { lookupPlay, nameSimilarity } from "./lib/play.mjs";
import { slugify, suggestPattern } from "./lib/assets.mjs";
import { boundedInteger, discoveryReport, discoverySummary, inspectionResult, recentlyMaintained } from "./lib/discovery.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const list = (name) => (opt(name) ? opt(name).split(",").map((s) => s.trim()).filter(Boolean) : []);

const LIMIT = boundedInteger(opt("limit", "40"), "limit", 1000);
const INSPECT_LIMIT = boundedInteger(opt("inspect-limit", String(LIMIT)), "inspect-limit", 1000);
const INSPECT = flag("inspect");
const WRITE = flag("write");
const MIN_STARS = boundedInteger(opt("min-stars", "150"), "min-stars", 1_000_000, 0);
const REPORT_PATH = path.resolve(opt("output", path.join(DIRS.root, "discovery-report.json")));
const SUMMARY_PATH = opt("summary");

const LICENSES = new Set([
  "0BSD", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "Apache-2.0", "Artistic-2.0",
  "BSD-2-Clause", "BSD-3-Clause", "BSL-1.0", "CC0-1.0", "EPL-2.0", "GPL-2.0", "GPL-2.0-only",
  "GPL-2.0-or-later", "GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later", "ISC", "LGPL-2.1",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0", "LGPL-3.0-only", "LGPL-3.0-or-later",
  "MIT", "MPL-2.0", "Unlicense", "Zlib",
]);

/** Default searches: broad enough to find things, narrow enough to stay useful. */
const DEFAULT_QUERIES = [
  "topic:android topic:f-droid stars:>150",
  "topic:android-app stars:>500",
  "topic:android topic:material-design stars:>800 archived:false",
  "topic:privacy topic:android stars:>300",
  "topic:shizuku stars:>150 archived:false",
  "topic:root topic:android stars:>150 archived:false",
];

/**
 * Libraries, SDKs and design systems publish sample APKs that pass every other
 * check. Cheap heuristics on topics and description catch most of them before we
 * waste a download on a `catalog-debug.apk`.
 */
function librarySignal(repo) {
  const topics = (repo.topics ?? []).map((t) => t.toLowerCase());
  if (topics.some((t) => ["library", "sdk", "framework", "components", "ui-kit", "sample-app"].includes(t))) {
    return true;
  }
  const text = `${repo.name ?? ""} ${repo.description ?? ""}`.toLowerCase();
  return /\b(sdk|library|components|design system|framework|sample app)\b/.test(text);
}

/* ------------------------------------------------------------------ search */
async function searchRepositories(query) {
  const found = [];
  for (const page of [1, 2]) {
    const url = `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=50&page=${page}`;
    const result = await githubApi(url);
    found.push(...(result.items ?? []));
    if ((result.items ?? []).length < 50) break;
  }
  return found;
}

/* ---------------------------------------------------------------- evaluate */
async function evaluate(repo, { knownRepos, knownPackages, knownIds }) {
  const row = {
    repo: repo.full_name,
    stars: repo.stargazers_count,
    archived: repo.archived,
    pushed: repo.pushed_at?.slice(0, 10),
    license: repo.license?.spdx_id ?? null,
    description: (repo.description ?? "").slice(0, 140),
    homepage: repo.homepage,
    releases: 0,
    downloads: 0,
    assetPattern: null,
    abiAssets: null,
    assetNames: [],
    assetSize: 0,
    apkAssetUrl: null,
    tag: null,
    prerelease: false,
    verdict: "candidata",
    reasons: [],
  };

  if (knownRepos.has(repo.full_name)) {
    row.verdict = "já indexada";
    return row;
  }
  if (repo.archived) {
    row.verdict = "arquivada";
    return row;
  }
  if (!recentlyMaintained(repo.pushed_at)) {
    row.verdict = "sem manutenção recente";
    row.reasons.push("sem atividade no repositório nos últimos 12 meses");
    return row;
  }
  if (!LICENSES.has(row.license ?? "")) {
    row.verdict = "licença";
    row.reasons.push(`licença ${row.license ?? "desconhecida"} não está na lista de licenças livres`);
    return row;
  }
  if (repo.stargazers_count < MIN_STARS) {
    row.verdict = "pouco popular";
    return row;
  }
  if (librarySignal(repo)) {
    row.verdict = "não é uma app";
    row.reasons.push("parece uma biblioteca/SDK, não uma aplicação instalável");
    return row;
  }

  let releases = [];
  try {
    releases = await githubApi(`/repos/${repo.full_name}/releases?per_page=20`);
  } catch (error) {
    row.verdict = "sem releases";
    row.reasons.push(String(error.message).split("\n")[0].slice(0, 100));
    return row;
  }
  row.releases = releases.length;

  const usable = releases
    .filter((r) => !r.draft)
    .map((release) => ({
      release,
      apks: (release.assets ?? []).filter((a) => /\.apk$/i.test(a.name)),
    }))
    .filter((entry) => entry.apks.length > 0);

  if (usable.length === 0) {
    row.verdict = "sem APK";
    row.reasons.push("nenhum release publica APKs");
    return row;
  }

  // Prefer the newest stable release that has APKs; fall back to prereleases.
  const stable = usable.find((entry) => !entry.release.prerelease);
  const chosen = stable ?? usable[0];
  row.tag = chosen.release.tag_name;
  row.prerelease = chosen.release.prerelease;
  row.assetNames = chosen.apks.map((a) => a.name);
  row.downloads = chosen.apks.reduce((sum, a) => sum + a.download_count, 0);

  const pattern = suggestPattern(chosen.apks);
  // Um store nunca deve indexar uma build de debug. O Termux é a exceção
  // conhecida (chama "debug" às suas releases assinadas), por isso é um aviso
  // com destaque, não uma rejeição automática.
  row.onlyDebugBuilds = chosen.apks.filter((a) => !/debug/i.test(a.name)).length === 0;
  if (row.onlyDebugBuilds) {
    row.reasons.push(
      `todos os APKs deste release têm "debug" no nome: ${chosen.apks.map((a) => a.name).join(", ")} — ` +
        "confirma se são builds de debug antes de indexar",
    );
  }
  row.assetPattern = pattern.assetPattern;
  row.abiAssets = pattern.abiAssets;
  row.assetSize = pattern.primary?.size ?? 0;
  row.apkAssetUrl = pattern.primary?.browser_download_url ?? null;
  if (pattern.notes.length) row.reasons.push(...pattern.notes);
  return row;
}

/* --------------------------------------------------------------- inspection */
async function inspectCandidate(row, tools, knownPackages) {
  if (!row.apkAssetUrl) return row;
  const file = await downloadCached(row.apkAssetUrl, { subdir: "discover", token: process.env.GITHUB_TOKEN });
  const info = await inspectApk(file, { tools });
  row.packageName = info.packageName;
  row.versionCode = info.versionCode;
  row.versionName = info.versionName;
  row.minSdk = info.minSdk;
  row.targetSdk = info.targetSdk;
  row.nativeAbis = info.nativeAbis;
  row.signingCertSha256 = info.signingCertSha256;
  row.size = (await fs.stat(file)).size;
  const result = inspectionResult(info, knownPackages);
  row.verdict = result.verdict;
  row.inspectionStatus = result.inspectionStatus;
  if (result.reason) row.reasons.push(result.reason);
  if (row.verdict !== "candidata") return row;
  try {
    row.play = await lookupPlay(info.packageName);
  } catch (error) {
    row.play = { present: null, reason: String(error.message).slice(0, 80) };
  }
  return row;
}

/* ------------------------------------------------------------------ writing */
async function writeEntry(row, { knownPackages, knownIds }) {
  const id = slugify(row.repo.split("/")[1]);
  if (knownIds.has(id)) {
    log.warn(`${id}: já existe um apps/${id}.json, salto`);
    return null;
  }
  if (row.packageName && knownPackages.has(row.packageName)) {
    log.warn(`${row.packageName}: já indexado, salto`);
    return null;
  }

  const name = row.repo.split("/")[1];
  const release = row.abiAssets
    ? {
        provider: "github",
        repo: row.repo,
        ...(row.abiAssets.universal ? {} : {}),
        abiAssets: row.abiAssets,
      }
    : { provider: "github", repo: row.repo, assetPattern: row.assetPattern ?? "*.apk" };

  const entry = {
    id,
    name,
    summary: (row.description || name).slice(0, 155),
    description: { en: (row.description || name).slice(0, 2000) },
    packageName: row.packageName,
    license: normaliseLicense(row.license),
    sourceCode: `https://github.com/${row.repo}`,
    ...(row.homepage ? { links: { website: row.homepage } } : {}),
    categories: [], // a human must choose from the taxonomy
    release,
    ...(row.play?.present === false ? { playStore: { present: false } } : {}),
    addedAt: new Date().toISOString().slice(0, 10),
    notes: [
      "Entrada gerada por tools/discover.mjs.",
      "FALTA: categories, tags, summary/description revistos, icon, e correr --update-pins.",
      row.prerelease ? `Atenção: o release escolhido (${row.tag}) é um prerelease.` : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
  // categories é obrigatório no schema: escreve um marcador para o validador
  // falhar de forma óbvia em vez de a entrada parecer completa.
  entry.categories = ["utilities"];

  await writeJson(path.join(DIRS.apps, `${id}.json`), entry);
  return id;
}

function normaliseLicense(spdx) {
  const map = {
    "GPL-3.0": "GPL-3.0-or-later",
    "GPL-2.0": "GPL-2.0-or-later",
    "AGPL-3.0": "AGPL-3.0-or-later",
    "LGPL-3.0": "LGPL-3.0-or-later",
    "LGPL-2.1": "LGPL-2.1-or-later",
  };
  return map[spdx] ?? spdx;
}

/* --------------------------------------------------------------------- main */
async function main() {
  await githubToken();
  const tools = INSPECT ? await findApkTools({ required: true }) : {};

  const existing = await Promise.all(
    (await fs.readdir(DIRS.apps))
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await fs.readFile(path.join(DIRS.apps, f), "utf8"))),
  );
  const knownRepos = new Set(existing.map((e) => e.release?.repo).filter(Boolean));
  const knownPackages = new Set(existing.map((e) => e.packageName));
  const knownIds = new Set(existing.map((e) => e.id));

  /* 1. candidates --------------------------------------------------------- */
  // Um seed traz o repositório pelo nome, mas não traz os metadados dele. Construí-lo
  // com `license: {}` fazia com que a verificação de licença o recusasse sempre —
  // "licença desconhecida não está na lista de licenças livres" — a menos que a busca
  // por omissão o encontrasse por acaso e preenchesse o campo. Ou seja: o `--seed` só
  // funcionava para repositórios que já apareciam sozinhos, que é exactamente o caso
  // em que não era preciso. Vai-se buscar os metadados à API.
  //
  // Se um seed não puder ser lido, isto falha em voz alta em vez de continuar: um
  // pedido explícito que não se consegue cumprir não pode dar um relatório sobre
  // outros repositórios, que é o defeito que esta correcção veio resolver.
  const seeds = await mapPool(list("seed"), 4, async (fullName) => {
    const repo = await githubApi(`/repos/${fullName}`);
    if (!repo?.full_name) {
      throw new Error(`--seed ${fullName}: a API respondeu ${repo?.message ?? "sem full_name"}`);
    }
    return repo;
  });
  const queries = [...DEFAULT_QUERIES, ...list("query")];
  const searchHits = [];
  for (const query of queries) {
    log.step(`a procurar: ${query}`);
    const found = await searchRepositories(query);
    log.info(`  ${found.length} repositórios`);
    searchHits.push(...found);
  }

  const byRepo = new Map();
  for (const repo of [...searchHits, ...seeds]) {
    const previous = byRepo.get(repo.full_name);
    if (!previous || (repo.stargazers_count ?? 0) > (previous.stargazers_count ?? 0)) {
      byRepo.set(repo.full_name, repo);
    }
  }
  // Um seed é uma instrução explícita: quem escreve `--seed owner/repo` quer aquele
  // repositório avaliado, não o mais popular que a busca encontrou. A ordenar só por
  // estrelas, os seeds ficavam em último (têm 0 — não vêm da busca) e o corte do
  // limite deitava-os fora: o `--seed` que o CONTRIBUTING e o docs/ADD_APP mandam
  // correr avaliava em silêncio os repositórios errados.
  const seeded = new Set(list("seed"));
  const candidates = [...byRepo.values()].sort((a, b) => {
    const seedA = seeded.has(a.full_name) ? 1 : 0;
    const seedB = seeded.has(b.full_name) ? 1 : 0;
    if (seedA !== seedB) return seedB - seedA;
    return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
  });
  log.step(`${candidates.length} repositórios únicos a avaliar (limite ${LIMIT})`);

  /* 2. evaluate ---------------------------------------------------------- */
  const evaluated = (
    await mapPool(candidates.slice(0, LIMIT), 4, (repo) =>
      evaluate(repo, { knownRepos, knownPackages, knownIds }).catch((error) => ({
        repo: repo.full_name,
        verdict: "erro",
        reasons: [String(error.message).slice(0, 120)],
      })),
    )
  ).filter(Boolean);

  /* 3. optionally inspect the top ones ----------------------------------- */
  const pool = evaluated.filter((row) => row.verdict === "candidata");
  if (INSPECT) {
    const toInspect = pool.slice(0, INSPECT_LIMIT);
    log.step(`a descarregar 1 APK por candidata para confirmar o package name (${toInspect.length})`);
    await mapPool(toInspect, 3, async (row) => {
      try {
        return await inspectCandidate(row, tools, knownPackages);
      } catch (error) {
        row.verdict = "inspeção falhou";
        row.inspectionStatus = "failed";
        row.reasons.push(String(error.message).slice(0, 120));
        return row;
      }
    });
  }

  /* 4. report ------------------------------------------------------------ */
  const report = discoveryReport(evaluated, { searches: queries, found: candidates.length });
  const good = report.candidates;

  console.log("");
  console.log(color.bold(`  ${good.length} candidatas utilizáveis\n`));
  for (const row of good) {
    const play =
      row.play == null
        ? color.dim("play=?")
        : row.play.present === false
          ? color.green("fora da Play")
          : row.play.present === true
            ? color.magenta("também na Play")
            : color.yellow("play=?");
    const mismatch =
      row.play?.present === true && nameSimilarity(row.repo.split("/")[1], row.play.playName) < 0.5
        ? color.yellow(` [nome no Play: "${row.play.playName}"]`)
        : "";
    console.log(
      `  ${color.bold(row.repo.padEnd(42))}${String(row.stars).padStart(7)}★  ` +
        `${(row.license ?? "?").padEnd(16)}${play}${mismatch}`,
    );
    console.log(
      `      ${color.dim(row.description)}` +
        (row.packageName ? `\n      ${color.dim(row.packageName)} v${row.versionName} (${row.versionCode}) ` +
          `minSdk ${row.minSdk} ${humanBytes(row.size ?? row.assetSize)} ${row.nativeAbis?.join(",") ?? ""}` : ""),
    );
    const releaseDesc = row.abiAssets
      ? `abiAssets: ${JSON.stringify(row.abiAssets)}`
      : `assetPattern: "${row.assetPattern}"`;
    console.log(`      ${color.cyan(releaseDesc)}`);
    for (const note of row.reasons) console.log(`      ${color.yellow("!")} ${note}`);
    console.log("");
  }

  const rejected = report.rejected;
  if (rejected.length) {
    console.log(color.dim(`  descartadas: ${rejected.length}`));
    const byVerdict = new Map();
    for (const row of rejected) byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
    for (const [verdict, count] of [...byVerdict].sort((a, b) => b[1] - a[1])) {
      console.log(color.dim(`    ${verdict}: ${count}`));
    }
  }

  await writeJson(REPORT_PATH, report);
  log.info(`relatório completo em ${REPORT_PATH}`);
  if (SUMMARY_PATH) {
    await fs.mkdir(path.dirname(path.resolve(SUMMARY_PATH)), { recursive: true });
    await fs.writeFile(SUMMARY_PATH, discoverySummary(report), "utf8");
  }

  if (WRITE) {
    console.log("");
    let written = 0;
    for (const row of good) {
      if (!row.packageName) {
        log.warn(`${row.repo}: sem inspeção não sei o package name; corre com --inspect`);
        continue;
      }
      const id = await writeEntry(row, { knownPackages, knownIds });
      if (id) {
        written++;
        log.ok(`apps/${id}.json criado (revê: categories, tags, summary, icon)`);
      }
    }
    if (written) {
      console.log("");
      log.warn("Entradas de rascunho: completa-as e depois corre");
      log.info("  node tools/build-index.mjs --deep 3 --update-pins && node tools/sign-index.mjs && node tools/verify-index.mjs");
    }
  } else if (good.length) {
    console.log("");
    log.info("para criar rascunhos de entradas: --inspect --write --limit N");
  }
}

await main();
