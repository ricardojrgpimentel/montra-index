#!/usr/bin/env node
// Maintainer utility: check a list of candidate repos for index-worthiness.
// Prints, for each: archived?, license, latest release tag, and the APK assets it
// publishes. This is the "does this app actually ship an APK on GitHub Releases?"
// question, answered before anyone hand-writes an apps/*.json entry.
//
//   node tools/probe.mjs owner/repo owner/repo2 ...
import { githubApi, githubToken } from "./lib/github.mjs";
import { color, humanBytes, log } from "./lib/util.mjs";

const repos = process.argv.slice(2);
if (!repos.length) {
  console.error("uso: node tools/probe.mjs owner/repo [owner/repo ...]");
  process.exit(2);
}

await githubToken();

const results = [];
for (const repo of repos) {
  const row = { repo, ok: false, archived: null, license: null, tag: null, apks: [], downloads: 0 };
  try {
    const info = await githubApi(`/repos/${repo}`);
    row.ok = true;
    row.archived = info.archived;
    row.license = info.license?.spdx_id ?? null;
    row.stars = info.stargazers_count;
    row.desc = info.description;
    row.pushed = info.pushed_at?.slice(0, 10);
    row.latestRelease = info.has_downloads === undefined ? null : null;
    try {
      const rel = await githubApi(`/repos/${repo}/releases?per_page=5`);
      const withApk = rel.find((r) => (r.assets ?? []).some((a) => /\.apk$/i.test(a.name)));
      const chosen = withApk ?? rel[0];
      if (chosen) {
        row.tag = chosen.tag_name;
        row.prerelease = chosen.prerelease;
        row.publishedAt = chosen.published_at?.slice(0, 10);
        row.apks = (chosen.assets ?? [])
          .filter((a) => /\.apk$/i.test(a.name))
          .map((a) => ({ name: a.name, size: a.size, downloads: a.download_count }));
        row.downloads = (chosen.assets ?? [])
          .filter((a) => /\.apk$/i.test(a.name))
          .reduce((sum, a) => sum + a.download_count, 0);
        row.assetCount = (chosen.assets ?? []).length;
        row.assetNames = (chosen.assets ?? []).map((a) => a.name).slice(0, 8);
      }
    } catch (e) {
      row.releaseError = String(e.message).slice(0, 120);
    }
  } catch (e) {
    row.error = String(e.message).split("\n")[0].slice(0, 120);
  }
  results.push(row);
}

console.log("");
for (const r of results) {
  const badge = !r.ok ? color.red("SEM REPO") : r.apks.length ? color.green("APK  ") : color.yellow("sem apk");
  console.log(`${badge} ${color.bold(r.repo)}`);
  if (!r.ok) {
    console.log(`      ${color.red(r.error)}`);
    continue;
  }
  console.log(
    `      licença=${r.license ?? "?"} estrelas=${r.stars} push=${r.pushed}${r.archived ? color.yellow(" ARQUIVADO") : ""}`,
  );
  console.log(`      ${color.dim((r.desc ?? "").slice(0, 100))}`);
  console.log(`      tag=${r.tag ?? "—"}${r.prerelease ? " (prerelease)" : ""} assets=${r.assetCount ?? 0}`);
  for (const a of r.apks) {
    console.log(`        ${a.name.padEnd(46)} ${humanBytes(a.size).padStart(8)}  ${a.downloads} downloads`);
  }
  if (!r.apks.length && r.assetNames?.length) console.log(`        ${color.dim("assets: " + r.assetNames.join(", "))}`);
}
console.log("");
console.log(JSON.stringify(results, null, 2));
