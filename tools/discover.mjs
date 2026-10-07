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

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const list = (name) => (opt(name) ? opt(name).split(",").map((s) => s.trim()).filter(Boolean) : []);

const LIMIT = Number(opt("limit", "40"));
const INSPECT = flag("inspect");
const WRITE = flag("write");
const MIN_STARS = Number(opt("min-stars", "150"));

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
];

function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
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
  if (!LICENSES.has(row.license ?? "")) {
    row.verdict = "licença";
    row.reasons.push(`licença ${row.license ?? "desconhecida"} não está na lista de licenças livres`);
    return row;
  }
  if (repo.stargazers_count < MIN_STARS) {
    row.verdict = "pouco popular";
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
  row.assetPattern = pattern.assetPattern;
  row.abiAssets = pattern.abiAssets;
  row.assetSize = pattern.primary?.size ?? 0;
  row.apkAssetUrl = pattern.primary?.browser_download_url ?? null;
  if (pattern.notes.length) row.reasons.push(...pattern.notes);
  return row;
}

/**
 * Work out how to describe a release's assets declaratively.
 *
 * A single APK is "universal". Several APKs whose names differ only by ABI are
 * per-ABI splits. Anything else (debug beside release, WebView beside browser)
 * needs a human, and we say so rather than guessing silently.
 */
function suggestPattern(apks) {
  const notes = [];
  const result = { assetPattern: null, abiAssets: null, primary: null, notes };

  if (apks.length === 1) {
    result.assetPattern = apks[0].name;
    result.primary = apks[0];
    return result;
  }

  const abiOf = (name) => {
    const n = name.toLowerCase();
    if (n.includes("arm64") || n.includes("aarch64")) return "arm64-v8a";
    if (n.includes("armeabi") || n.includes("armv7") || /(^|[^a-z0-9])arm([^a-z0-9]|$)/.test(n)) return "armeabi-v7a";
    if (n.includes("x86_64") || n.includes("x64")) return "x86_64";
    if (n.includes("x86")) return "x86";
    if (n.includes("universal") || n.includes("all")) return "universal";
    return null;
  };

  const byAbi = new Map();
  let unlabelled = 0;
  for (const apk of apks) {
    const abi = abiOf(apk.name);
    if (abi == null) unlabelled++;
    if (!byAbi.has(abi)) byAbi.set(abi, []);
    byAbi.get(abi).push(apk);
  }

  if (unlabelled === apks.length) {
    notes.push(`${apks.length} APKs e nenhum nome revela a ABI: precisa de assetPattern/abiAssets à mão`);
    result.assetPattern = "*.apk";
    result.primary = [...apks].sort((a, b) => b.size - a.size)[0];
    return result;
  }

  const abiAssets = {};
  for (const [abi, group] of byAbi) {
    const key = abi ?? "universal";
    // Turn the concrete name into a glob: replace version-ish and hash-ish parts.
    const pattern = group[0].name.replace(/[0-9]+\.[0-9]+(\.[0-9]+)?[^/]*/, "*").replace(/^app-/, "app-");
    abiAssets[key] = group.length === 1 ? group[0].name : pattern;
    if (group.length > 1) notes.push(`${group.length} APKs para ${key}: ${group.map((a) => a.name).join(", ")}`);
  }
  result.abiAssets = abiAssets;
  result.primary = abiAssets.universal
    ? byAbi.get("universal")[0]
    : [...apks].sort((a, b) => b.size - a.size)[0];

  const debug = apks.filter((a) => /debug/i.test(a.name));
  if (debug.length) notes.push(`há builds de debug no release (${debug.map((a) => a.name).join(", ")}): exclui-os`);
  return result;
}

/* --------------------------------------------------------------- inspection */
async function inspectCandidate(row, tools) {
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
  const seeds = list("seed").map((s) => ({ full_name: s, stargazers_count: 0, license: {}, pushed_at: null }));
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
  const candidates = [...byRepo.values()].sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
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
  let pool = evaluated.filter((row) => row.verdict === "candidata");
  if (INSPECT) {
    const toInspect = pool.slice(0, Number(opt("inspect-limit", String(pool.length))));
    log.step(`a descarregar 1 APK por candidata para confirmar o package name (${toInspect.length})`);
    const inspected = await mapPool(toInspect, 3, async (row) => {
      try {
        return await inspectCandidate(row, tools);
      } catch (error) {
        row.verdict = "inspeção falhou";
        row.reasons.push(String(error.message).slice(0, 120));
        return row;
      }
    });
    pool = inspected;
  }

  /* 4. report ------------------------------------------------------------ */
  const good = pool
    .filter((row) => row.verdict === "candidata")
    .sort((a, b) => {
      const aOff = a.play?.present === false ? 1 : 0;
      const bOff = b.play?.present === false ? 1 : 0;
      if (aOff !== bOff) return bOff - aOff;
      return (b.downloads ?? 0) - (a.downloads ?? 0) || b.stars - a.stars;
    });

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

  const rejected = evaluated.filter((row) => row.verdict !== "candidata");
  if (rejected.length) {
    console.log(color.dim(`  descartadas: ${rejected.length}`));
    const byVerdict = new Map();
    for (const row of rejected) byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
    for (const [verdict, count] of [...byVerdict].sort((a, b) => b[1] - a[1])) {
      console.log(color.dim(`    ${verdict}: ${count}`));
    }
  }

  await writeJson(path.join(DIRS.root, "discovery-report.json"), { generatedAt: new Date().toISOString(), candidates: good.map((row) => ({ ...row, play: row.play ?? null })) });
  log.info("relatório completo em discovery-report.json");

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
