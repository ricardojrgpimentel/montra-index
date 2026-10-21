// O registo das apps que falharam não pode viver só no run do Actions: o log
// desaparece e o resumo do run não se lê uma semana depois. Este estado é
// commitado com o índice — quem abre o repositório vê o que está preso, desde
// quando, com que versão ficou e porquê, que é o que diz se há algo a mudar do
// nosso lado (pattern, package, pin, ou a própria entrada).

const short = (iso) => (typeof iso === "string" ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "?");

/**
 * Estado da próxima build a partir do anterior. Uma app que continua a falhar
 * mantém o `failingSince` original; uma que recuperou desaparece da lista (o
 * histórico fica no git, que é onde ele já está).
 *
 * @param {{apps?: Record<string, object>}|null} previous estado lido do repositório
 * @param {Array<{id: string, message: string, published?: object|null, release?: object|null}>} failures
 * @param {{now?: Date}} [options]
 */
export function updateHealth(previous, failures, { now = new Date() } = {}) {
  const at = now.toISOString();
  const apps = {};

  for (const failure of failures ?? []) {
    if (!failure?.id) continue;
    const before = previous?.apps?.[failure.id];
    apps[failure.id] = {
      failingSince: before?.failingSince ?? at,
      lastFailureAt: at,
      lastError: String(failure.message ?? "").trim(),
      published: failure.published ?? null,
      release: failure.release ?? null,
    };
  }

  return { updatedAt: at, apps };
}

/**
 * Versão legível do estado, para `docs/BUILD_HEALTH.md`.
 *
 * @param {ReturnType<typeof updateHealth>} health
 * @param {{totalApps?: number|null}} [options]
 */
export function renderHealth(health, { totalApps = null } = {}) {
  const ids = Object.keys(health.apps ?? {}).sort();
  const when = short(health.updatedAt);
  const lines = ["# Estado da construção", ""];

  if (!ids.length) {
    lines.push(
      `Actualizado em ${when}. Sem falhas` +
        (totalApps != null ? `: as ${totalApps} apps resolveram.` : "."),
      "",
    );
    return lines.join("\n");
  }

  lines.push(
    `Actualizado em ${when}. ${ids.length} app(s) falharam e ficaram com a versão já publicada ` +
      "(ou de fora, quando não havia nenhuma).",
    "",
  );

  for (const id of ids) {
    const app = health.apps[id];
    lines.push(`## ${id}`, "");
    lines.push(`- falha desde ${short(app.failingSince)}; última tentativa em ${short(app.lastFailureAt)}`);
    if (app.published) {
      lines.push(
        `- mantém a versão ${app.published.versionName ?? "?"} ` +
          `(resolvida em ${short(app.published.resolvedAt)})`,
      );
    } else {
      lines.push("- não havia versão publicada: ficou de fora do índice");
    }
    if (app.release) {
      const bits = [`provider ${app.release.provider ?? "?"}`];
      if (app.release.repo) bits.push(`repo ${app.release.repo}`);
      if (app.release.tagPattern) bits.push(`tagPattern ${app.release.tagPattern}`);
      if (app.release.assetPattern) bits.push(`assetPattern ${app.release.assetPattern}`);
      if (app.release.abiAssets) bits.push(`abiAssets ${Object.keys(app.release.abiAssets).join(", ")}`);
      lines.push(`- entrada: ${bits.join(", ")}`);
    }
    lines.push("- motivo:", "", "  ```", ...String(app.lastError).split("\n").map((l) => `  ${l}`), "  ```", "");
  }

  lines.push(
    "## O que verificar",
    "",
    "- **O release mudou de nome** — ajustar `assetPattern`/`abiAssets`; se o repositório publica várias app, `tagPattern`.",
    "- **O package mudou** — corrigir `packageName` em `apps/<id>.json` e explicar nas `notes` que quem tem a versão anterior não recebe esta actualização.",
    "- **A chave de assinatura mudou** — só com `--update-pins`, e só depois de confirmar com o upstream que a rotação é legítima.",
    "- **A app acabou** — `status: archived` ou `deprecated`, ou remover a entrada.",
    "",
    "Este ficheiro é escrito por `tools/build-index.mjs` a cada build; o estado em bruto está em `build-health.json`.",
    "",
  );

  return lines.join("\n");
}
