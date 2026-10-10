#!/usr/bin/env node
// Prepare one reviewable, schema-valid draft per selected repo. No signing key.
// All output lives in --output; temporary entries are removed after verification.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { DIRS, downloadCached, indexPathFor, log, sha256File, writeJson } from "./lib/util.mjs";
import { githubApi, githubToken } from "./lib/github.mjs";
import { findApkTools, inspectApk } from "./lib/apk.mjs";
import { recentlyMaintained } from "./lib/discovery.mjs";
import { apkReleaseCandidates } from "./lib/releases.mjs";
import { suggestPattern } from "./lib/assets.mjs";
import { lookupPlay } from "./lib/play.mjs";
import { selectedRepos, proposalBranch, proposedLicense, proposedMedia, proposedRelease, proposedEntry, proposalBody } from "./lib/proposals.mjs";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const repos = selectedRepos(option("repos", process.env.SELECTED_REPOS));
const output = path.resolve(option("output", ".cache/proposals"));
const catalogue = process.env.GITHUB_REPOSITORY || "ricardojrgpimentel/montra-index";
selectedRepos(catalogue);

async function main() {
  await githubToken();
  const tools = await findApkTools({ required: true });
  if (!tools.apksigner || !tools.javaHome) throw new Error("A preparação exige apksigner e JDK para verificar todos os certificados.");
  const schema = JSON.parse(await fs.readFile(path.join(DIRS.schema, "app.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const licenses = new Set(schema.properties.license.oneOf[0].enum);
  const existing = await Promise.all((await fs.readdir(DIRS.apps)).filter((f) => f.endsWith(".json"))
    .map(async (f) => JSON.parse(await fs.readFile(path.join(DIRS.apps, f), "utf8"))));
  const knownRepos = new Set(existing.map((e) => e.release?.repo?.toLowerCase()));
  const knownPackages = new Set(existing.map((e) => e.packageName));
  const knownIds = new Set(existing.map((e) => e.id));
  const snapshotHash = await sha256File(path.join(DIRS.root, "index.json"));
  const signatureHash = await sha256File(path.join(DIRS.root, "index.json.sig"));
  const manifest = { version: 1, catalogue, proposals: [], skipped: [], failed: [] };
  await fs.mkdir(output, { recursive: true });

  for (const selected of repos) {
    let tempEntry;
    try {
      if (knownRepos.has(selected)) {
        manifest.skipped.push({ repo: selected, reason: "já indexada" }); continue;
      }
      const repo = await githubApi(`/repos/${selected}`);
      const branch = proposalBranch(repo.full_name);
      const open = await githubApi(`/repos/${catalogue}/pulls?head=${encodeURIComponent(`${catalogue.split("/")[0]}:${branch}`)}&state=open`);
      if (open.length) {
        manifest.skipped.push({ repo: selected, reason: "já tem proposta aberta; preservadas as edições de revisão", url: open[0].html_url }); continue;
      }
      if (repo.archived || !recentlyMaintained(repo.pushed_at)) throw new Error("Projeto arquivado ou sem manutenção nos últimos 12 meses.");
      const releases = await githubApi(`/repos/${repo.full_name}/releases?per_page=100`);
      const release = apkReleaseCandidates(releases)[0];
      if (!release) throw new Error("Não há release estável com APK.");
      const apks = release.assets.filter((asset) => /\.apk$/i.test(asset.name) && !/debug/i.test(asset.name));
      const primary = suggestPattern(apks).primary;
      if (!primary) throw new Error("Não há APK sem indicação de debug; esta app precisa de preparação manual.");
      const apk = await downloadCached(primary.browser_download_url, { subdir: "apk", token: process.env.GITHUB_TOKEN });
      const info = await inspectApk(apk, { tools });
      if (!info.packageName || !info.signingCertSha256) throw new Error("Package ou certificado não verificável no APK selecionado.");
      if (knownPackages.has(info.packageName)) {
        manifest.skipped.push({ repo: selected, reason: "package já indexado" }); continue;
      }
      const licence = await githubApi(`/repos/${repo.full_name}/license?ref=${encodeURIComponent(release.tag_name)}`);
      const content = Buffer.from(licence.content ?? "", "base64").toString("utf8");
      const license = proposedLicense(licence.license?.spdx_id, content, licenses);
      const config = proposedRelease(repo.full_name, release, primary, info);
      const warnings = [];
      let media = {};
      try {
        const tree = await githubApi(`/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
        media = proposedMedia(repo.full_name, tree.tree ?? []);
        if (tree.truncated) warnings.push("A listagem de ficheiros de origem está truncada; confirma as imagens manualmente.");
      } catch {
        warnings.push("Não foi possível procurar imagens; podes acrescentar os caminhos na entrada.");
      }
      if (!media.icon) warnings.push("Não foi encontrado ícone no fastlane; o catálogo suporta monograma ou podes acrescentar um ícone.");
      let play;
      try { play = await lookupPlay(info.packageName); } catch { warnings.push("Presença na Play Store por confirmar."); }
      const entry = proposedEntry({ repo, info, license, licenseUrl: licence.html_url, media, release: config, play });
      if (knownIds.has(entry.id)) throw new Error(`O id ${entry.id} já existe; escolhe um id manualmente.`);
      if (!validate(entry)) throw new Error(`Entrada inválida: ${ajv.errorsText(validate.errors)}`);
      const entryPath = path.join(DIRS.apps, `${entry.id}.json`);
      // Exclusive write: a selected repo can never overwrite an existing app.
      await fs.writeFile(entryPath, JSON.stringify(entry, null, 2) + "\n", { flag: "wx" });
      tempEntry = entryPath;
      const build = await execFileAsync(process.execPath, [path.join(DIRS.root, "tools/build-index.mjs"), "--only", entry.id, "--deep", "3", "--no-icons"],
        { maxBuffer: 16 * 1024 * 1024 });
      await fs.writeFile(path.join(output, `${entry.id}-verification.log`), build.stdout + build.stderr);
      const built = JSON.parse(await fs.readFile(indexPathFor(entry.id), "utf8")).apps[0];
      if (built?.release?.tag !== release.tag_name) throw new Error("O release mudou durante a preparação; repete para rever os metadados da mesma versão.");
      if (!built?.release?.assets?.length || built.release.assets.some((asset) => !asset.signingCertSha256 || asset.signingCertSha256 !== info.signingCertSha256)) {
        throw new Error("A assinatura de todos os APKs selecionados não ficou confirmada.");
      }
      if (built.warnings?.length) warnings.push(...built.warnings);
      const runUrl = process.env.GITHUB_RUN_ID ? `https://github.com/${catalogue}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
      const body = proposalBody({ catalogue, branch, entry, built, licenseUrl: licence.html_url, warnings, runUrl });
      manifest.proposals.push({ repo: repo.full_name, branch, entry, body, built });
      knownIds.add(entry.id); knownPackages.add(entry.packageName); knownRepos.add(selected);
      log.ok(`${repo.full_name}: proposta preparada; ${built.release.assets.length} APK(s) verificado(s)`);
    } catch (error) {
      const reason = String(error.message).slice(0, 1200);
      manifest.failed.push({ repo: selected, reason });
      log.error(`${selected}: ${reason.split("\n")[0]}`);
    } finally {
      if (tempEntry) await fs.unlink(tempEntry);
    }
  }
  if (await sha256File(path.join(DIRS.root, "index.json")) !== snapshotHash || await sha256File(path.join(DIRS.root, "index.json.sig")) !== signatureHash) {
    throw new Error("A preparação alterou o catálogo publicado; não publicar propostas.");
  }
  await writeJson(path.join(output, "manifest.json"), manifest);
  log.info(`${manifest.proposals.length} propostas, ${manifest.skipped.length} ignoradas, ${manifest.failed.length} falharam.`);
  if (manifest.failed.length) process.exitCode = 1;
}

await main();
