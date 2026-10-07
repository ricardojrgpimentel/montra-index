#!/usr/bin/env node
// Build index.json from apps/*.json.
//
// For every entry this downloads the newest release APK, hashes it, reads its real
// manifest with aapt2 and its signing certificate with apksigner, and cross-checks
// all of that against what the entry claims. Nothing here trusts upstream metadata:
// the APK is the source of truth, because that is the file a user will install.
//
//   node tools/build-index.mjs                  full build (downloads APKs, cached)
//   node tools/build-index.mjs --dry            resolve releases only, no APK downloads
//   node tools/build-index.mjs --only f-droid   one app
//   node tools/build-index.mjs --deep 3         inspect the 3 newest candidate releases
//   node tools/build-index.mjs --update-pins    write observed certificate pins back
//                                               into apps/*.json (reviewable diff!)
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DIRS, color, downloadCached, fetchWithRetry, globMatch, globToRegExp, hexToColon,
  humanBytes, log, mapPool, progressBar, sha256File, writeJson,
} from "./lib/util.mjs";
import { githubApi, githubToken } from "./lib/github.mjs";
import { findApkTools, inspectApk } from "./lib/apk.mjs";
import { inferAbi } from "./lib/assets.mjs";

/* -------------------------------------------------------------------- argv */
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const DRY = flag("dry");
const UPDATE_PINS = flag("update-pins");
const ONLY = opt("only");
const DEEP = Number(opt("deep", "1"));
const CONCURRENCY = Number(opt("jobs", "3"));
const SKIP_ICONS = flag("no-icons");

const IMAGE_MAGIC = [
  { ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "gif", test: (b) => b.subarray(0, 3).toString("latin1") === "GIF" },
];

function imageExtension(buffer) {
  for (const { ext, test } of IMAGE_MAGIC) if (test(buffer)) return ext;
  const head = buffer.subarray(0, 200).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "svg";
  return null;
}

const warningsFor = new Map();
const warnFor = (id, message) => {
  if (!warningsFor.has(id)) warningsFor.set(id, []);
  warningsFor.get(id).push(message);
  log.warn(`${id}: ${message}`);
};

/* ----------------------------------------------------------- release lookup */
const ghHeaders = async () => {
  const token = await githubToken();
  return token ? { authorization: `Bearer ${token}` } : {};
};

async function githubReleases(repo) {
  const headers = await ghHeaders();
  const releases = [];
  for (const page of [1, 2]) {
    const batch = await githubApi(`/repos/${repo}/releases?per_page=50&page=${page}`, { token: headers.authorization?.split(" ")[1] });
    releases.push(...batch);
    if (batch.length < 50) break;
  }
  return releases.filter((r) => !r.draft);
}

/** Pick the release assets that match the entry's patterns. */
function matchAssets(entry, release) {
  const rel = entry.release;
  const exclude = rel.excludePattern ? globToRegExp(rel.excludePattern) : null;
  const candidates = (release.assets ?? []).filter((a) => /\.apk$/i.test(a.name) && !(exclude && exclude.test(a.name)));

  const picks = [];
  const claimed = new Set();
  const assign = (abi, asset) => {
    if (claimed.has(asset.name)) return;
    claimed.add(asset.name);
    picks.push({ abi, asset });
  };

  // Explicit per-ABI configuration wins. Nothing else is inferred from the
  // leftovers: a repo that publishes ChromePublic.apk next to SystemWebView.apk
  // must not have the WebView silently promoted to "universal".
  const abiEntries = Object.entries(rel.abiAssets ?? {});
  if (abiEntries.length) {
    for (const [abi, pattern] of abiEntries) {
      const matches = candidates.filter((a) => globMatch(pattern, a.name));
      if (matches.length === 0) {
        warnFor(entry.id, `abiAssets["${abi}"] (${pattern}) não encontrou nada no release ${release.tag_name}`);
        continue;
      }
      if (matches.length > 1) {
        warnFor(entry.id, `abiAssets["${abi}"] (${pattern}) casou com ${matches.length} assets; a usar o maior`);
      }
      assign(abi, matches.sort((a, b) => b.size - a.size)[0]);
    }
    return picks;
  }

  const primaryPattern = rel.assetPattern ?? "*.apk";
  const primary = candidates.filter((a) => globMatch(primaryPattern, a.name));
  if (primary.length === 0) return [];

  if (primary.length === 1) {
    assign("universal", primary[0]);
    return picks;
  }

  // Several matches and no explicit config: if the file names carry a consistent
  // ABI, treat them as per-ABI splits. Otherwise be loud about the ambiguity.
  const inferred = primary.map((asset) => ({ asset, abi: inferAbi(asset.name) }));
  const abis = inferred.map((i) => i.abi);
  if (rel.allowMultiple || abis.every(Boolean) || new Set(abis.filter(Boolean)).size === primary.length) {
    for (const { asset, abi } of inferred) {
      if (!abi) warnFor(entry.id, `não consegui inferir a ABI de "${asset.name}": a marcar como universal`);
      assign(abi ?? "universal", asset);
    }
    return picks;
  }

  warnFor(
    entry.id,
    `${primary.length} assets casam com "${primaryPattern}" (${primary.map((a) => a.name).join(", ")}) e as ABIs não são claras; ` +
      "a usar o maior como universal. Declara abiAssets para escolher exatamente o que serve.",
  );
  assign("universal", primary.sort((a, b) => b.size - a.size)[0]);
  return picks;
}

/* ------------------------------------------------------------ apk inspection */
async function inspectAsset(entry, pick, tools) {
  const { asset, abi } = pick;
  const file = await downloadCached(asset.browser_download_url, {
    subdir: "apk",
    filename: asset.name,
    token: process.env.GITHUB_TOKEN,
    onProgress: (p) => {
      if (!p.cached && p.total && p.received === p.total) {
        process.stdout.write(`\r    ${abi} ${progressBar(p)}   \n`);
      }
    },
  });
  const [sha256, size, info] = await Promise.all([
    sha256File(file),
    fs.stat(file).then((s) => s.size),
    inspectApk(file, { tools }),
  ]);
  return { abi, asset, file, sha256, size, info };
}

/* ----------------------------------------------------------------- app build */
async function buildApp(entry, tools, ctx) {
  const rel = entry.release;
  if (rel.provider !== "github") {
    warnFor(entry.id, `provider "${rel.provider}" ainda não é resolvido automaticamente: entrada marcada como não instalável`);
    return null;
  }

  let releases;
  try {
    releases = await githubReleases(rel.repo);
  } catch (error) {
    throw new Error(`falha a listar releases de ${rel.repo}: ${String(error.message).split("\n")[0]}`);
  }

  const tagRe = rel.tagPattern ? globToRegExp(rel.tagPattern) : null;
  const candidates = releases
    .filter((r) => rel.includePrerelease || !r.prerelease)
    .filter((r) => !tagRe || tagRe.test(r.tag_name))
    .sort((a, b) => new Date(b.published_at ?? 0) - new Date(a.published_at ?? 0));

  if (candidates.length === 0) throw new Error(`nenhum release elegível em ${rel.repo}`);

  let chosen = null;
  let picks = [];
  for (const candidate of candidates.slice(0, Math.max(1, DEEP))) {
    const matched = matchAssets(entry, candidate);
    if (matched.length) {
      chosen = candidate;
      picks = matched;
      break;
    }
    log.info(`  ${entry.id}: release ${candidate.tag_name} sem assets correspondentes, a tentar o anterior`);
  }
  if (!chosen) {
    throw new Error(
      `nenhum release de ${rel.repo} tem assets que caiam em assetPattern="${rel.assetPattern ?? "*.apk"}". ` +
        `Assets vistos: ${(candidates[0].assets ?? []).map((a) => a.name).join(", ") || "(nenhum)"}`,
    );
  }

  if (DRY) {
    return {
      dry: true,
      tag: chosen.tag_name,
      assets: picks.map((p) => ({ abi: p.abi, name: p.asset.name, size: p.asset.size })),
      downloads: picks.reduce((sum, p) => sum + (p.asset.download_count ?? 0), 0),
    };
  }

  const inspected = [];
  for (const pick of picks) {
    log.info(`  ${entry.id}: ${pick.abi} ← ${pick.asset.name} (${humanBytes(pick.asset.size)})`);
    inspected.push(await inspectAsset(entry, pick, tools));
  }

  // --- the APK is the source of truth ---------------------------------------
  for (const item of inspected) {
    const { info, asset } = item;
    if (!info.packageName) throw new Error(`${asset.name}: aapt2 não leu o package name`);
    if (info.packageName !== entry.packageName) {
      throw new Error(
        `${asset.name}: package name real é "${info.packageName}" mas apps/${entry.id}.json diz "${entry.packageName}". ` +
          "Corrige a entrada (ou o assetPattern, se este não é o APK da aplicação).",
      );
    }
    if (!info.versionCode) throw new Error(`${asset.name}: versionCode ilegível`);
  }

  const versionCodes = inspected.map((i) => i.info.versionCode);
  const primary = inspected.find((i) => i.abi === "universal") ?? inspected[0];
  const versionCode = Math.max(...versionCodes);
  if (new Set(versionCodes).size > 1) {
    warnFor(entry.id, `versionCode difere entre ABIs (${versionCodes.join(", ")}); a usar ${versionCode}`);
  }

  const fingerprints = new Set(inspected.map((i) => i.info.signingCertSha256).filter(Boolean));
  if (fingerprints.size > 1) {
    throw new Error(
      `ABIs do mesmo release estão assinadas por chaves diferentes (${[...fingerprints].join(", ")}). ` +
        "Isso impediria atualizações e é sinal de release adulterado.",
    );
  }
  const observedCert = [...fingerprints][0] ?? null;
  for (const item of inspected) {
    if (item.info.signerError) {
      warnFor(entry.id, `apksigner falhou em ${item.asset.name}: ${item.info.signerError.split("\n")[0]}`);
    }
  }
  const pinnedCert = entry.verification?.signingCertSha256 ?? null;

  if (pinnedCert && observedCert && pinnedCert.toLowerCase() !== observedCert.toLowerCase()) {
    throw new Error(
      `CERTIFICADO DE ASSINATURA MUDOU em ${entry.id}!\n` +
        `    fixado em apps/${entry.id}.json: ${pinnedCert}\n` +
        `    no APK de ${chosen.tag_name}:     ${observedCert}\n` +
        "    Se a app mudou de chave legitimamente (rotação), atualiza o pin de forma explícita com\n" +
        "    --update-pins e explica no commit. Caso contrário, NÃO publiques este índice.",
    );
  }
  if (!pinnedCert && observedCert) {
    ctx.newPins.push({ id: entry.id, cert: observedCert });
    log.info(`  ${entry.id}: novo pin de certificado ${observedCert}${UPDATE_PINS ? " (a gravar)" : " (corre --update-pins para fixar)"}`);
  }
  if (pinnedCert && !observedCert) {
    warnFor(entry.id, "não foi possível confirmar o fingerprint do APK (apksigner indisponível)");
  }

  const minSdk = Math.max(...inspected.map((i) => i.info.minSdk ?? 0)) || null;
  const nativeAbis = [...new Set(inspected.flatMap((i) => i.info.nativeAbis))].sort();
  if (entry.requires?.minSdk && minSdk && entry.requires.minSdk !== minSdk) {
    warnFor(entry.id, `requires.minSdk diz ${entry.requires.minSdk} mas o APK declara ${minSdk}`);
  }

  const assets = inspected
    .map((item) => ({
      abi: item.abi,
      url: item.asset.browser_download_url,
      sha256: item.sha256,
      size: item.size,
      signingCertSha256: item.info.signingCertSha256 ?? null,
      versionCode: item.info.versionCode,
      versionName: item.info.versionName ?? null,
      minSdk: item.info.minSdk ?? null,
      targetSdk: item.info.targetSdk ?? null,
      nativeAbis: item.info.nativeAbis,
      verifiedAt: new Date().toISOString(),
    }))
    .sort((a, b) => abiRank(a.abi) - abiRank(b.abi));

  const preferred = assets.find((a) => a.abi === "universal") ?? assets.find((a) => a.abi === "arm64-v8a") ?? assets[0];
  const downloads = picks.reduce((sum, p) => sum + (p.asset.download_count ?? 0), 0);

  return {
    version: { versionName: primary.info.versionName ?? chosen.tag_name, versionCode },
    release: {
      versionName: primary.info.versionName ?? chosen.tag_name,
      versionCode,
      tag: chosen.tag_name,
      publishedAt: chosen.published_at ?? null,
      releaseUrl: chosen.html_url ?? null,
      changelog: (chosen.body ?? "").trim().slice(0, 2000) || null,
      assets,
    },
    signingCertSha256: observedCert,
    minSdk,
    targetSdk: primary.info.targetSdk ?? null,
    nativeAbis,
    iconUrl: null,
    screenshotUrls: [],
    downloadCount: downloads,
    artifact: { url: preferred.url, sha256: preferred.sha256, size: preferred.size, abi: preferred.abi },
    warnings: warningsFor.get(entry.id) ?? [],
  };
}

const abiRank = (abi) => ["universal", "arm64-v8a", "armeabi-v7a", "x86_64", "x86"].indexOf(abi) + 1 || 99;

/* --------------------------------------------------------------- media (icons) */
async function fetchRemote(url, token) {
  const res = await fetchWithRetry(url, {
    headers: token && url.includes("github") ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function resolveMediaSource(source) {
  if (typeof source === "string") return source;
  return `https://raw.githubusercontent.com/${source.repo}/HEAD/${source.path.replace(/^\//, "")}`;
}

async function rehostMedia(entry, ctx) {
  if (SKIP_ICONS) return { icon: null, screenshots: [] };

  const token = process.env.GITHUB_TOKEN;
  let icon = null;
  const screenshots = [];

  if (entry.icon) {
    const url = resolveMediaSource(entry.icon);
    try {
      const buffer = await fetchRemote(url, token);
      const ext = imageExtension(buffer);
      if (!ext) {
        warnFor(entry.id, `ícone em ${url} não é PNG/JPEG/WebP/GIF/SVG reconhecível; ignorado`);
      } else if (ext === "svg") {
        warnFor(entry.id, "ícone é SVG (o cliente precisaria de um descodificador extra); ignorado");
      } else {
        const file = path.join(DIRS.icons, `${entry.id}.${ext}`);
        await fs.mkdir(DIRS.icons, { recursive: true });
        await fs.writeFile(file, buffer);
        icon = `icons/${entry.id}.${ext}`;
        ctx.mediaHosted++;
      }
    } catch (error) {
      warnFor(entry.id, `falha a buscar o ícone (${url}): ${String(error.message).slice(0, 80)}`);
    }
  }

  for (const [index, shot] of (entry.screenshots ?? []).entries()) {
    const url = resolveMediaSource(shot);
    try {
      const buffer = await fetchRemote(url, token);
      const ext = imageExtension(buffer);
      if (!ext || ext === "svg") {
        warnFor(entry.id, `screenshot ${index + 1} ignorado (formato não suportado)`);
        continue;
      }
      const dir = path.join(DIRS.screenshots, entry.id);
      await fs.mkdir(dir, { recursive: true });
      const rel = `screenshots/${entry.id}/${index + 1}.${ext}`;
      await fs.writeFile(path.join(DIRS.root, rel), buffer);
      screenshots.push(rel);
      ctx.mediaHosted++;
    } catch (error) {
      warnFor(entry.id, `falha no screenshot ${index + 1}: ${String(error.message).slice(0, 80)}`);
    }
  }

  return { icon, screenshots };
}

/* ------------------------------------------------------------------- main */
async function main() {
  const started = Date.now();
  await githubToken();

  let files = (await fs.readdir(DIRS.apps)).filter((f) => f.endsWith(".json")).sort();
  if (ONLY) {
    files = files.filter((f) => f === `${ONLY}.json` || f === `${ONLY}`);
    if (!files.length) {
      log.error(`nenhuma entrada corresponde a --only ${ONLY}`);
      process.exit(1);
    }
  }

  const entries = [];
  for (const file of files) {
    const entry = JSON.parse(await fs.readFile(path.join(DIRS.apps, file), "utf8"));
    if (entry.status === "archived" || entry.status === "deprecated") {
      log.warn(`${entry.id}: status=${entry.status} — a resolver na mesma (os utilizadores precisam de saber o que têm instalado)`);
    }
    entries.push(entry);
  }

  log.step(`a construir o índice para ${entries.length} apps${DRY ? color.yellow(" (dry run)") : ""}`);

  const tools = DRY ? {} : await findApkTools({ required: true });
  if (!DRY && !tools.apksigner) {
    log.warn("apksigner em falta: os fingerprints de certificado ficarão nulos nesta build");
  }

  const ctx = { newPins: [], mediaHosted: 0, failures: [] };

  const results = await mapPool(entries, CONCURRENCY, async (entry) => {
    try {
      const built = await buildApp(entry, tools, ctx);
      return { entry, built };
    } catch (error) {
      ctx.failures.push({ id: entry.id, message: String(error.message) });
      log.error(`${entry.id}: ${String(error.message).split("\n")[0]}`);
      return { entry, built: null, error };
    }
  });

  const apps = [];
  for (const { entry, built } of results) {
    if (!built) continue;
    if (built.dry) {
      apps.push({ entry, built });
      continue;
    }
    const media = await rehostMedia(entry, ctx);
    apps.push({ entry, built, media });
  }

  /* --- write pins back into apps/*.json (reviewable diff) ------------------ */
  if (UPDATE_PINS && ctx.newPins.length) {
    for (const pin of ctx.newPins) {
      const file = path.join(DIRS.apps, `${pin.id}.json`);
      const entry = JSON.parse(await fs.readFile(file, "utf8"));
      entry.verification = {
        ...(entry.verification ?? {}),
        signingCertSha256: pin.cert,
        pinnedAt: new Date().toISOString().slice(0, 10),
      };
      await writeJson(file, entry);
    }
    log.ok(`${ctx.newPins.length} pin(s) de certificado gravados em apps/*.json — revê o diff antes de commitar`);
  }

  if (DRY) {
    console.log("");
    for (const { entry, built } of apps) {
      console.log(
        `  ${color.bold(entry.name.padEnd(20))}${(built.tag ?? "").padEnd(16)}${built.assets.map((a) => `${a.abi}:${a.name}`).join("  ")}`,
      );
    }
    const failed = ctx.failures.length;
    console.log("");
    if (failed) log.error(`${failed} app(s) sem release resolvível`);
    log.ok(`dry run concluído em ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(failed ? 1 : 0);
  }

  /* --- emit index.json ---------------------------------------------------- */
  const indexApps = apps
    .map(({ entry, built, media }) => ({
      id: entry.id,
      name: entry.name,
      summary: entry.summary,
      description: entry.description ?? { en: entry.summary },
      packageName: entry.packageName,
      license: entry.license,
      sourceCode: entry.sourceCode,
      ...(entry.author ? { author: entry.author } : {}),
      categories: entry.categories ?? [],
      tags: entry.tags ?? [],
      status: entry.status ?? "active",
      antiFeatures: entry.antiFeatures ?? [],
      ...(entry.links ? { links: entry.links } : {}),
      ...(entry.playStore ? { playStore: entry.playStore } : {}),
      addedAt: entry.addedAt ?? null,
      icon: media?.icon ?? null,
      screenshots: media?.screenshots ?? [],
      downloadCount: built.downloadCount ?? null,
      signingCertSha256: built.signingCertSha256 ?? null,
      resolvedAt: new Date().toISOString(),
      release: built.release,
      artifact: built.artifact,
      ...(built.warnings?.length ? { warnings: built.warnings } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));

  const { keyIdFromPublicKeyPem } = await import("./lib/keys.mjs");
  let signingKeyId = null;
  try {
    signingKeyId = keyIdFromPublicKeyPem(await fs.readFile(path.join(DIRS.keys, "index-signing.pub.pem"), "utf8"));
  } catch {
    log.warn("sem chave pública: o índice sai sem signingKeyId (não assines assim)");
  }

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generator: "montra-index build-index.mjs",
    ...(signingKeyId ? { signingKeyId } : {}),
    apps: indexApps,
  };

  await writeJson(path.join(DIRS.out, "index.json"), index);

  /* --- report ------------------------------------------------------------- */
  console.log("");
  const totalSize = indexApps.reduce((sum, a) => sum + (a.artifact?.size ?? 0), 0);
  for (const app of indexApps) {
    const abis = app.release.assets.map((a) => a.abi.replace("universal", "all")).join(",");
    console.log(
      `  ${color.green("✓")} ${color.bold(app.name.padEnd(20))}${String(app.release.versionName).padEnd(14)}` +
        `${color.dim(abis.padEnd(20))}${color.dim(humanBytes(app.artifact?.size ?? 0).padStart(9))}` +
        `${app.signingCertSha256 ? color.dim("  " + app.signingCertSha256.slice(0, 17) + "…") : color.yellow("  sem cert")}`,
    );
  }
  console.log("");
  log.ok(
    `index.json: ${indexApps.length} apps, ${humanBytes(totalSize)} de APKs indexados` +
      `${ctx.mediaHosted ? `, ${ctx.mediaHosted} imagens re-alojadas` : ""}`,
  );
  if (ctx.failures.length) {
    console.log("");
    for (const f of ctx.failures) log.error(`${f.id}: ${f.message.split("\n")[0]}`);
    log.error(`${ctx.failures.length} app(s) falharam`);
  }
  console.log("");
  log.info(`tempo: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`${color.dim("próximo passo:")} node tools/sign-index.mjs\n`);

  process.exit(ctx.failures.length ? 1 : 0);
}

await main();
