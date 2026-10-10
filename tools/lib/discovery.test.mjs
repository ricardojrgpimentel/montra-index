import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedInteger, discoveryReport, discoverySummary, inspectionResult, recentlyMaintained } from "./discovery.mjs";

const now = new Date("2026-10-10T12:00:00Z");
const row = (repo, fields = {}) => ({ repo, verdict: "candidata", stars: 200, downloads: 20, reasons: [], ...fields });
const report = (rows) => discoveryReport(rows, { searches: ["topic:android"], found: 100, now });

describe("discovery review rules", () => {
  it("rejects invalid or unbounded input before searching or downloading", () => {
    assert.equal(boundedInteger("120", "limit", 1000), 120);
    assert.equal(boundedInteger("0", "min-stars", 1_000_000, 0), 0);
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "1001", "$(command)"]) {
      assert.throws(() => boundedInteger(value, "limit", 1000), /--limit/);
    }
  });

  it("requires repository activity in the last twelve months", () => {
    assert.equal(recentlyMaintained("2025-10-10T12:00:00Z", now), true);
    assert.equal(recentlyMaintained("2025-10-10T11:59:59Z", now), false);
    assert.equal(recentlyMaintained("2026-10-09T12:00:00Z", now), true);
    assert.equal(recentlyMaintained(null, now), false);
    assert.equal(recentlyMaintained("invalid", now), false);
  });

  it("does not treat unsigned or uninspectable APKs as inspected candidates", () => {
    const known = new Set(["dev.existing.app"]);
    const signed = { packageName: "dev.new.app", signingCertSha256: "aa:bb" };
    assert.equal(inspectionResult(signed, known).verdict, "candidata");
    assert.equal(inspectionResult({ ...signed, packageName: "dev.existing.app" }, known).verdict, "package já indexado");
    assert.equal(inspectionResult({ ...signed, signingCertSha256: null }, known).inspectionStatus, "failed");
    assert.equal(inspectionResult({ ...signed, packageName: null }, known).inspectionStatus, "failed");
    assert.equal(inspectionResult({ ...signed, signingCertSha256: null, signerError: "bad signature" }, known).reason, "bad signature");
  });

  it("retains candidates beyond the inspection limit and records failures", () => {
    const result = report([
      row("a/inspected", { inspectionStatus: "verified", play: { present: false } }),
      row("b/pending"),
      row("c/failed", { verdict: "inspeção falhou", inspectionStatus: "failed" }),
      row("d/duplicate", { verdict: "package já indexado", inspectionStatus: "verified" }),
    ]);
    assert.deepEqual(result.candidates.map((r) => r.repo), ["a/inspected", "b/pending"]);
    assert.deepEqual(result.stats, { found: 100, evaluated: 4, candidates: 2, inspected: 2,
      inspectionFailed: 1, pendingInspection: 1, rejected: 2 });
    assert.equal(result.candidates[1].play, null);
    assert.equal(result.rejected.length, 2);
  });

  it("prioritises confirmed off-Play candidates without assuming unknown means absent", () => {
    const result = report([
      row("a/unknown", { downloads: 999 }),
      row("b/off-play", { downloads: 1, play: { present: false } }),
      row("c/debug", { downloads: 9999, onlyDebugBuilds: true }),
    ]);
    assert.deepEqual(result.candidates.map((r) => r.repo), ["b/off-play", "a/unknown", "c/debug"]);
  });

  it("escapes upstream text and labels pending inspection clearly in summaries", () => {
    const summary = discoverySummary(report([
      row("owner/app", { license: "MIT | injected\n<script>", packageName: "a`b",
        reasons: ["[click](https://example.com) | <img>"] }),
      row("bad/repo](https://example.com)"),
    ]));
    assert.ok(summary.includes("[owner/app](https://github.com/owner/app)"));
    assert.ok(summary.includes("MIT \\| injected &lt;script&gt;"));
    assert.ok(summary.includes("Por inspecionar"));
    assert.ok(summary.includes("Por confirmar"));
    assert.ok(!summary.includes("<img>"));
    assert.ok(!summary.includes("https://github.com/bad/"));
    assert.ok(summary.includes("Nenhuma app foi adicionada automaticamente"));
  });

  it("reports an empty search without reusing previous candidates", () => {
    const empty = report([]);
    assert.equal(empty.generatedAt, now.toISOString());
    assert.deepEqual(empty.candidates, []);
    assert.match(discoverySummary(empty), /Nenhuma candidata/);
  });
});
