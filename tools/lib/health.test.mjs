import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHealth, updateHealth } from "./health.mjs";

const failure = {
  id: "ente",
  message: "nenhum release de ente/ente tem assets que caiam em assetPattern=\"ente-photos-v*.apk\".",
  published: { versionName: "1.3.65", resolvedAt: "2026-10-12T16:23:34.016Z" },
  release: { provider: "github", repo: "ente/ente", tagPattern: "photos-v*" },
};

test("a primeira falha fixa o início; a seguinte mantém-no", () => {
  const first = updateHealth(null, [failure], { now: new Date("2026-10-19T09:00:00Z") });
  assert.equal(first.apps.ente.failingSince, "2026-10-19T09:00:00.000Z");

  const second = updateHealth(first, [failure], { now: new Date("2026-10-21T09:00:00Z") });
  assert.equal(second.apps.ente.failingSince, "2026-10-19T09:00:00.000Z");
  assert.equal(second.apps.ente.lastFailureAt, "2026-10-21T09:00:00.000Z");
});

test("uma app que recuperou desaparece do estado", () => {
  const previous = updateHealth(null, [failure], { now: new Date("2026-10-19T09:00:00Z") });
  const next = updateHealth(previous, [], { now: new Date("2026-10-22T09:00:00Z") });
  assert.deepEqual(next.apps, {});
});

test("sem falhas, o documento diz que está tudo bem", () => {
  const health = updateHealth(null, [], { now: new Date("2026-10-21T09:00:00Z") });
  const md = renderHealth(health, { totalApps: 81 });
  assert.match(md, /Sem falhas: as 81 apps resolveram/);
  assert.doesNotMatch(md, /## ente/);
});

test("uma falha aparece com versão publicada, entrada e motivo", () => {
  const health = updateHealth(null, [failure], { now: new Date("2026-10-21T09:00:00Z") });
  const md = renderHealth(health, { totalApps: 81 });
  assert.match(md, /## ente/);
  assert.match(md, /mantém a versão 1\.3\.65/);
  assert.match(md, /tagPattern photos-v\*/);
  assert.match(md, /ente-photos-v\*\.apk/);
  assert.match(md, /O que verificar/);
});

test("uma app sem versão anterior é assinalada como fora do índice", () => {
  const health = updateHealth(null, [{ id: "nova", message: "falhou" }], { now: new Date("2026-10-21T09:00:00Z") });
  const md = renderHealth(health, { totalApps: 81 });
  assert.match(md, /ficou de fora do índice/);
});
