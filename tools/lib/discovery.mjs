// Reporting and review rules shared by local discovery and GitHub Actions.
export function boundedInteger(value, name, maximum, minimum = 1) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`--${name} tem de ser um inteiro entre ${minimum} e ${maximum}`);
  }
  return number;
}

export function recentlyMaintained(pushedAt, now = new Date()) {
  const pushed = new Date(pushedAt ?? "");
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return Number.isFinite(pushed.getTime()) && pushed >= cutoff;
}

export function inspectionResult(info, knownPackages) {
  if (!info.packageName || !info.signingCertSha256) {
    return {
      verdict: "inspeção falhou",
      inspectionStatus: "failed",
      reason: info.signerError || "APK sem package name ou certificado de assinatura verificável",
    };
  }
  return {
    verdict: knownPackages.has(info.packageName) ? "package já indexado" : "candidata",
    inspectionStatus: "verified",
  };
}

export function discoveryReport(rows, { searches, found, now = new Date() }) {
  const candidates = rows.filter((row) => row.verdict === "candidata").sort((a, b) => {
    const offPlay = (row) => row.play?.present === false ? 1 : 0;
    if (offPlay(a) !== offPlay(b)) return offPlay(b) - offPlay(a);
    if (!!a.onlyDebugBuilds !== !!b.onlyDebugBuilds) return a.onlyDebugBuilds ? 1 : -1;
    return (b.downloads ?? 0) - (a.downloads ?? 0) || a.stars - b.stars;
  });
  const rejected = rows.filter((row) => row.verdict !== "candidata");
  return {
    generatedAt: now.toISOString(),
    searches,
    stats: {
      found,
      evaluated: rows.length,
      candidates: candidates.length,
      inspected: rows.filter((row) => row.inspectionStatus === "verified").length,
      inspectionFailed: rows.filter((row) => row.inspectionStatus === "failed").length,
      pendingInspection: candidates.filter((row) => row.inspectionStatus !== "verified").length,
      rejected: rejected.length,
    },
    candidates: candidates.map((row) => ({ ...row, play: row.play ?? null })),
    rejected,
  };
}

// Repository metadata is untrusted text; keep it inside its Markdown cell.
function cell(value) {
  return String(value ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/[\r\n]+/g, " ")
    .replace(/[\\|`*_[\]]/g, "\\$&");
}

export function discoverySummary(report) {
  const { stats } = report;
  const lines = [
    "# Descoberta de apps",
    "",
    `${stats.evaluated} repositórios avaliados de ${stats.found} encontrados; ` +
      `**${stats.candidates} candidatas**. ${stats.inspected} APKs inspecionados, ` +
      `${stats.pendingInspection} candidatas por inspecionar e ${stats.inspectionFailed} falhas de inspeção.`,
    "",
    "Estas candidatas precisam de revisão de licença, variante do APK, certificado, " +
      "requisitos de acesso, descrição e imagens antes de entrar no catálogo.",
    "O relatório JSON e o log completo estão no artefacto desta execução. Nenhuma app foi adicionada automaticamente.",
    "Para preparar as candidatas escolhidas: [abrir o formulário propose-apps](https://github.com/ricardojrgpimentel/montra-index/actions/workflows/propose-apps.yml), " +
      "selecionar **Run workflow** e indicar os repositórios. Será criado um PR em rascunho por app, com a revisão ainda por completar.",
    "",
    "| Repositório | Licença declarada | Package | Play Store | APK |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of report.candidates) {
    const repo = /^[\w.-]+\/[\w.-]+$/.test(row.repo)
      ? `[${cell(row.repo)}](https://github.com/${row.repo})` : cell(row.repo);
    const play = row.play?.present === false ? "Fora da Play"
      : row.play?.present === true ? "Também na Play" : "Por confirmar";
    const apk = row.inspectionStatus === "verified" ? "Inspecionado" : "Por inspecionar";
    lines.push(`| ${repo} | ${cell(row.license)} | ${cell(row.packageName)} | ${play} | ${apk} |`);
  }
  if (!report.candidates.length) lines.push("", "Nenhuma candidata nesta pesquisa.");
  const warnings = report.candidates.filter((row) => row.reasons?.length);
  if (warnings.length) {
    lines.push("", "## Pontos a rever", "");
    for (const row of warnings) lines.push(`- ${cell(row.repo)}: ${row.reasons.map(cell).join("; ")}`);
  }
  if (report.rejected.length) {
    const counts = new Map();
    for (const row of report.rejected) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
    lines.push("", "## Descartadas nesta execução", "");
    for (const [verdict, count] of counts) lines.push(`- ${cell(verdict)}: ${count}`);
  }
  return lines.join("\n") + "\n";
}
