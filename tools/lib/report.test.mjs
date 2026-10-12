// Tests do relatório de curadoria. A regra de "app parada" é a mesma que o
// cliente usa para avisar de uma versão antiga: se divergir, o relatório manda
// procurar trabalho onde não há, ou esconde uma app abandonada.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReport, isStale, monthsBefore, monthsBetween, summariseIndex } from "./report.mjs";

const app = (id, overrides = {}) => ({
  id,
  name: id,
  screenshots: [`screenshots/${id}/1.webp`],
  icon: `icons/${id}.png`,
  antiFeatures: [],
  release: { publishedAt: "2026-09-01T00:00:00Z", changelog: "notas", assets: [{ size: 100 }], ...overrides.release },
  artifact: { size: 100 },
  playStore: { present: false },
  ...overrides,
});

describe("isStale", () => {
  const now = "2026-10-12T00:00:00Z";

  it("acusação só depois de seis meses completos", () => {
    assert.equal(isStale("2026-04-12T00:00:00Z", now), false);
    assert.equal(isStale("2026-04-11T00:00:00Z", now), true);
    assert.equal(isStale("2026-03-14T00:00:00Z", now), true);
    assert.equal(isStale("2026-10-01T00:00:00Z", now), false);
  });

  it("sem data não há acusação", () => {
    assert.equal(isStale(null, now), false);
    assert.equal(isStale(undefined, now), false);
    assert.equal(isStale("", now), false);
    assert.equal(isStale("nem-uma-data", now), false);
  });

  it("não transborda no fim do mês", () => {
    // 31 de agosto menos seis meses é 28 de fevereiro, não 3 de março: um
    // setUTCMonth ingénuo tornava a app parada três dias mais cedo.
    assert.equal(monthsBefore(new Date("2026-08-31T00:00:00Z"), 6).toISOString(), new Date("2026-02-28T00:00:00Z").toISOString());
    assert.equal(isStale("2026-02-28T00:00:00Z", "2026-08-31T00:00:00Z"), false);
    assert.equal(isStale("2026-02-27T00:00:00Z", "2026-08-31T00:00:00Z"), true);
  });

  it("conta os meses para mostrar, arredondando para baixo", () => {
    assert.equal(monthsBetween("2026-03-14T00:00:00Z", "2026-10-12T00:00:00Z"), 6);
    assert.equal(monthsBetween("2026-04-12T00:00:00Z", "2026-10-12T00:00:00Z"), 6);
    assert.equal(monthsBetween("2025-01-01T00:00:00Z", "2026-10-12T00:00:00Z"), 21);
    assert.equal(monthsBetween(null, "2026-10-12T00:00:00Z"), null);
  });
});

describe("summariseIndex", () => {
  const index = {
    generatedAt: "2026-10-12T11:57:43Z",
    apps: [
      app("completa", { accessRequirements: { mode: "optional" } }),
      app("sem-tudo", {
        screenshots: [],
        icon: null,
        antiFeatures: [],
        release: { publishedAt: "2024-01-24T00:00:00Z", changelog: null, assets: [{ size: 500 }, { size: 250 }] },
      }),
      app("parcial", {
        screenshots: [],
        icon: "icons/parcial.webp",
        antiFeatures: ["noTracking"],
        release: { publishedAt: "2026-04-11T00:00:00Z", changelog: "x", assets: [{ size: 10 }] },
      }),
    ],
  };
  const summary = summariseIndex(index, { now: "2026-10-12T00:00:00Z", indexBytes: 4096 });

  it("conta os totais", () => {
    assert.equal(summary.apps, 3);
    assert.equal(summary.indexBytes, 4096);
    assert.equal(summary.apkBytes, 860);
    assert.equal(summary.notOnPlayStore, 3);
    assert.equal(summary.playStoreUnknown, 0);
    assert.equal(summary.generatedAt, "2026-10-12T11:57:43Z");
  });

  it("lista o que falta, por id", () => {
    assert.deepEqual(summary.missingScreenshots, { count: 2, ids: ["sem-tudo", "parcial"] });
    assert.deepEqual(summary.missingIcon, { count: 1, ids: ["sem-tudo"] });
    assert.deepEqual(summary.missingChangelog, { count: 1, ids: ["sem-tudo"] });
    // "parcial" tem antiFeatures, por isso não conta como sem metadados.
    assert.deepEqual(summary.missingRequirements, { count: 1, ids: ["sem-tudo"] });
  });

  it("lista as paradas da mais antiga para a mais recente, com a data", () => {
    assert.equal(summary.stale.count, 2);
    assert.deepEqual(
      summary.stale.apps.map((a) => a.id),
      ["sem-tudo", "parcial"],
    );
    assert.equal(summary.stale.apps[0].publishedAt, "2024-01-24T00:00:00Z");
    assert.equal(summary.stale.apps[0].months, 32);
    // A "completa" lançou em setembro: não está parada.
    assert.ok(!summary.stale.apps.some((a) => a.id === "completa"));
  });

  it("um índice sem apps não rebenta", () => {
    const empty = summariseIndex({ apps: [] }, { now: "2026-10-12T00:00:00Z" });
    assert.equal(empty.apps, 0);
    assert.equal(empty.apkBytes, 0);
    assert.equal(empty.stale.count, 0);
  });

  it("conta como sem confirmação tudo o que não é true nem false", () => {
    const s = summariseIndex({ apps: [app("a", { playStore: undefined }), app("b")] });
    assert.equal(s.playStoreUnknown, 1);
    assert.equal(s.notOnPlayStore, 1);
  });
});

describe("formatReport", () => {
  it("imprime números e nomes, e a data do último lançamento", () => {
    const summary = summariseIndex(
      {
        generatedAt: "2026-10-12T11:57:43Z",
        apps: [app("velha", { release: { publishedAt: "2024-01-24T00:00:00Z", changelog: "x", assets: [{ size: 1 }] } })],
      },
      { now: "2026-10-12T00:00:00Z", indexBytes: 1024 },
    );
    const text = formatReport(summary);
    assert.match(text, /apps: 1/);
    assert.match(text, /Sem capturas de ecrã: 0/);
    assert.match(text, /Paradas \(sem lançamentos há mais de 6 meses\): 1/);
    assert.match(text, /velha: 2024-01-24 \(32 meses completos\)/);
  });
});
