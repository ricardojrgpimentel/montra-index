// Uma app que falha na build não pode levar as outras 80 atrás. Em vez de deixar
// o índice congelado à espera de correcção, a entrada que já estava publicada
// mantém-se tal e qual: mesma versão, mesmos hashes, mesmo certificado. O que se
// perde é a actualização dessa app, não a do catálogo inteiro.

/**
 * Separa as apps que falharam nesta build entre as que têm uma entrada anterior
 * para reutilizar e as que não têm (entradas novas, ou a primeira build).
 *
 * @param {Array<object>|null|undefined} previousApps apps do index.json publicado
 * @param {Array<string>} failedIds ids que falharam nesta build
 * @returns {{ carried: Array<object>, orphans: Array<string> }}
 */
export function carryOver(previousApps, failedIds) {
  const byId = new Map();
  for (const app of previousApps ?? []) {
    if (app?.id) byId.set(app.id, app);
  }

  const carried = [];
  const orphans = [];
  for (const id of new Set(failedIds ?? [])) {
    const previous = byId.get(id);
    if (previous) carried.push(previous);
    else orphans.push(id);
  }

  return { carried, orphans };
}
