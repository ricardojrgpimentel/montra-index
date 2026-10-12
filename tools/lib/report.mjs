// Cálculo do relatório de curadoria (tools/report.mjs).
//
// Separado do CLI para ser testável: a regra de "app parada" tem de ser a mesma
// que o cliente usa, e uma contagem errada manda alguém procurar um PR onde não
// há nada para fazer.
import { humanBytes } from "./util.mjs";

/**
 * Sem lançamentos há mais de seis meses.
 *
 * Meses de calendário, não 180 dias: é o que um leitor entende por "seis meses",
 * e é o que o cliente faz. Estritamente mais de seis: um release de exatamente
 * seis meses atrás ainda não conta.
 */
export const STALE_MONTHS = 6;

/** O mesmo dia, N meses antes, em UTC. */
export function monthsBefore(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  // Ancorar no dia 1 antes de mexer no mês: sem isto, 31 de agosto menos seis
  // meses transborda para 3 de março em vez de parar em 28 de fevereiro, e a app
  // ficava "parada" três dias mais cedo do que devia.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Data válida, ou null. Um null/"" não pode virar 1970 por acidente do Date. */
const parseDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Uma data ausente ou ilegível não é uma acusação: sem data não se afirma que a
 * app está parada, porque não há nada para afirmar.
 */
export function isStale(publishedAt, now = new Date(), months = STALE_MONTHS) {
  const published = parseDate(publishedAt);
  const reference = parseDate(now);
  if (!published || !reference) return false;
  return published.getTime() < monthsBefore(reference, months).getTime();
}

/** Meses de calendário completos entre duas datas (para mostrar "há N meses"). */
export function monthsBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Contagens e listas do que falta ao catálogo.
 *
 * `indexBytes` e `apkBytes` são números de um índice já publicado: servem para
 * ver a evolução ao longo do tempo, não para decidir nada.
 */
export function summariseIndex(index, { now = new Date(), indexBytes = null } = {}) {
  const apps = index?.apps ?? [];

  const missingScreenshots = apps.filter((a) => !(a.screenshots ?? []).length);
  const missingIcon = apps.filter((a) => !a.icon);
  const missingChangelog = apps.filter((a) => !(a.release?.changelog ?? "").trim());
  // Sem accessRequirements nem antiFeatures não se sabe se a app precisa de
  // Shizuku/root nem o que ela faz de estranho: é a lacuna que mais pesa na ficha.
  const missingRequirements = apps.filter((a) => !a.accessRequirements && !(a.antiFeatures ?? []).length);

  const stale = apps
    .filter((a) => isStale(a.release?.publishedAt, now))
    .map((a) => ({
      id: a.id,
      name: a.name,
      publishedAt: a.release.publishedAt,
      months: monthsBetween(a.release.publishedAt, now),
    }))
    // O mais antigo primeiro: é por onde se começa a olhar.
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));

  // Soma de todos os assets, não só do artefacto preferido: é o que um telemóvel
  // pode vir a descarregar (um por ABI) e é o número que o README publica.
  const apkBytes = apps.reduce(
    (sum, a) => sum + (a.release?.assets ?? []).reduce((s, asset) => s + (asset.size ?? 0), 0),
    0,
  );

  const notOnPlayStore = apps.filter((a) => a.playStore?.present === false);
  const playStoreUnknown = apps.filter((a) => a.playStore?.present !== true && a.playStore?.present !== false);

  return {
    generatedAt: index?.generatedAt ?? null,
    apps: apps.length,
    indexBytes,
    apkBytes,
    notOnPlayStore: notOnPlayStore.length,
    playStoreUnknown: playStoreUnknown.length,
    missingScreenshots: { count: missingScreenshots.length, ids: missingScreenshots.map((a) => a.id) },
    missingIcon: { count: missingIcon.length, ids: missingIcon.map((a) => a.id) },
    missingChangelog: { count: missingChangelog.length, ids: missingChangelog.map((a) => a.id) },
    missingRequirements: { count: missingRequirements.length, ids: missingRequirements.map((a) => a.id) },
    stale: {
      count: stale.length,
      months: STALE_MONTHS,
      apps: stale,
    },
  };
}

const list = (ids) => (ids.length ? ids.join(", ") : "—");

/** Relatório em texto. Números e nomes, sem adjetivos. */
export function formatReport(summary) {
  const lines = [];
  lines.push(`Relatório de curadoria — index.json gerado em ${summary.generatedAt ?? "?"}`);
  lines.push("");
  lines.push("Totais");
  lines.push(`  apps: ${summary.apps}`);
  lines.push(`  índice: ${summary.indexBytes === null ? "?" : humanBytes(summary.indexBytes)}`);
  lines.push(`  APKs indexados (todos os assets): ${humanBytes(summary.apkBytes)}`);
  lines.push(`  fora da Play Store (playStore.present=false): ${summary.notOnPlayStore}`);
  lines.push(`  sem confirmação da Play Store: ${summary.playStoreUnknown}`);
  lines.push("");
  lines.push(`Sem capturas de ecrã: ${summary.missingScreenshots.count}`);
  lines.push(`  ${list(summary.missingScreenshots.ids)}`);
  lines.push("");
  lines.push(`Sem ícone (o cliente desenha um monograma): ${summary.missingIcon.count}`);
  lines.push(`  ${list(summary.missingIcon.ids)}`);
  lines.push("");
  lines.push(`Sem changelog: ${summary.missingChangelog.count}`);
  lines.push(`  ${list(summary.missingChangelog.ids)}`);
  lines.push("");
  lines.push(`Sem accessRequirements nem antiFeatures: ${summary.missingRequirements.count}`);
  lines.push(`  ${list(summary.missingRequirements.ids)}`);
  lines.push("");
  lines.push(`Paradas (sem lançamentos há mais de ${summary.stale.months} meses): ${summary.stale.count}`);
  for (const app of summary.stale.apps) {
    // "meses completos" e não "meses": uma app de 15 de março, vista a 12 de
    // outubro, tem 6 meses completos e já está parada pela regra — sem a palavra,
    // o número parecia contradizer o cabeçalho.
    const months = app.months === null ? "?" : `${app.months} meses completos`;
    lines.push(`  ${app.id}: ${String(app.publishedAt).slice(0, 10)} (${months})`);
  }
  return lines.join("\n");
}
