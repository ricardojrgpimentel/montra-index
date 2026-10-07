#!/usr/bin/env node
// Check whether each indexed app is also published on Google Play, and record it.
//
// Why this matters: "this app is not on the Play Store" is a factual claim the
// client shows to users, and a stale claim is a lie. Play returns 404 for absent
// packages; for present ones we read the real listing name and developer, which
// doubles as a sanity check that the package name we track is the app we think
// it is (a copycat with the same package name would show up as a different name).
//
//   node tools/check-play.mjs              report only
//   node tools/check-play.mjs --update     write playStore{present,url} into apps/*.json
import fs from "node:fs/promises";
import path from "node:path";
import { DIRS, color, log, mapPool, sleep, writeJson } from "./lib/util.mjs";
import { lookupPlay, nameSimilarity } from "./lib/play.mjs";

const UPDATE = process.argv.includes("--update");
const CONCURRENCY = 4;

async function main() {
  const files = (await fs.readdir(DIRS.apps)).filter((f) => f.endsWith(".json")).sort();
  log.step(`a verificar ${files.length} packages no Google Play`);

  const results = await mapPool(files, CONCURRENCY, async (file) => {
    const entry = JSON.parse(await fs.readFile(path.join(DIRS.apps, file), "utf8"));
    await sleep(Math.random() * 300);
    let lookup;
    try {
      lookup = await lookupPlay(entry.packageName);
    } catch (error) {
      lookup = { present: null, url: null, reason: String(error.message).slice(0, 80) };
    }
    return { file, entry, lookup };
  });

  let changed = 0;
  let unknown = 0;
  console.log("");
  for (const { file, entry, lookup } of results) {
    const { present } = lookup;
    if (present === null) {
      unknown++;
      log.warn(`${entry.id}: não consegui determinar (${lookup.reason ?? lookup.status})`);
      continue;
    }
    const declared = entry.playStore?.present;
    const label = present ? color.magenta("Play ✓") : color.green("só aqui");
    const mismatch =
      declared !== undefined && declared !== present
        ? color.yellow(` [declarado: ${declared ? "presente" : "ausente"} — DESATUALIZADO]`)
        : "";

    let nameWarning = "";
    if (present && lookup.playName && nameSimilarity(entry.name, lookup.playName) < 0.5) {
      nameWarning = color.yellow(` [nome no Play: "${lookup.playName}" de ${lookup.playAuthor ?? "?"} — confirma que é a mesma app]`);
    }

    console.log(
      `  ${label.padEnd(12)}${color.bold(entry.id.padEnd(20))}${color.dim(entry.packageName)}${mismatch}${nameWarning}`,
    );

    const desired = present ? { present: true, url: lookup.url } : { present: false };
    if (UPDATE && JSON.stringify(entry.playStore ?? null) !== JSON.stringify(desired)) {
      entry.playStore = desired;
      await writeJson(path.join(DIRS.apps, file), entry);
      changed++;
    }
  }

  console.log("");
  const onPlay = results.filter((r) => r.lookup.present === true).length;
  const offPlay = results.filter((r) => r.lookup.present === false).length;
  log.ok(`${offPlay} apps só fora da Play Store, ${onPlay} também na Play${unknown ? `, ${unknown} indeterminadas` : ""}`);
  if (UPDATE && changed) log.ok(`${changed} entrada(s) atualizada(s) — revê o diff`);
  if (!UPDATE) console.log(color.dim("  (corre com --update para gravar o campo playStore)\n"));
}

await main();
