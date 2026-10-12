#!/usr/bin/env node
// Relatório do que falta ao catálogo, a partir do index.json publicado.
//
// Serve para escolher o próximo PR de curadoria com números em vez de impressões:
// quantas apps não têm capturas, ícone, changelog ou requisitos declarados, e
// quais são as que não lançam nada há mais de seis meses. Lê o índice publicado
// (não reconstrói nada, não precisa de rede nem da chave privada).
//
//   node tools/report.mjs                 relatório em texto
//   node tools/report.mjs --json          o mesmo, legível por máquina
//   node tools/report.mjs --index other-index.json
//   node tools/report.mjs --now 2026-10-12T00:00:00Z   data de referência (testes)
import fs from "node:fs/promises";
import path from "node:path";
import { DIRS, log, readJson } from "./lib/util.mjs";
import { formatReport, summariseIndex } from "./lib/report.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

async function main() {
  const file = path.resolve(DIRS.root, opt("index", path.join(DIRS.out, "index.json")));
  const nowArg = opt("now");

  let stat;
  let index;
  try {
    stat = await fs.stat(file);
    index = await readJson(file);
  } catch (error) {
    log.error(`não consegui ler ${file}: ${String(error.message).split("\n")[0]}`);
    process.exit(1);
  }

  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) {
    log.error(`--now ${nowArg} não é uma data`);
    process.exit(1);
  }

  const summary = summariseIndex(index, { now, indexBytes: stat.size });

  if (flag("json")) {
    console.log(JSON.stringify({ index: path.relative(DIRS.root, file), ...summary }, null, 2));
    return;
  }
  console.log(formatReport(summary));
}

await main();
