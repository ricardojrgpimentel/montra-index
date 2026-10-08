import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apkReleaseCandidates } from "./releases.mjs";

const release = (tag, date, assets, overrides = {}) => ({
  tag_name: tag, published_at: date, assets: assets.map((name) => ({ name })),
  draft: false, prerelease: false, ...overrides,
});

describe("apkReleaseCandidates", () => {
  it("encontra o último APK mesmo depois de quatro releases sem APK, preservando a data antiga", () => {
    const lastApk = release("2.2.3", "2024-12-07T19:36:07Z", ["app-release.apk"]);
    const releases = [
      release("2.2.7", "2025-12-03T06:22:55Z", []),
      release("2.2.6", "2025-11-25T13:25:44Z", ["source.zip"]),
      release("2.2.5", "2025-11-18T09:08:00Z", []),
      release("2.2.4", "2025-11-13T20:15:03Z", []),
      lastApk,
      release("2.2.2", "2024-12-02T17:45:13Z", ["app-release.apk"]),
    ];
    assert.equal(apkReleaseCandidates(releases).slice(0, 3)[0], lastApk);
    assert.equal(lastApk.published_at, "2024-12-07T19:36:07Z");
  });

  it("mantém as restrições de drafts, prereleases e tags", () => {
    const stable = release("v1", "2024-01-01", ["app.apk"]);
    const beta = release("v2", "2025-01-01", ["app.APK"], { prerelease: true });
    const draft = release("v3", "2026-01-01", ["app.apk"], { draft: true });
    const nightly = release("nightly", "2026-01-02", ["app.apk"]);
    const releases = [draft, stable, nightly, beta];
    assert.deepEqual(apkReleaseCandidates(releases, { tagPattern: "v*" }), [stable]);
    assert.deepEqual(apkReleaseCandidates(releases, { tagPattern: "v*", includePrerelease: true }), [beta, stable]);
  });

  it("não oferece releases sem artefactos Android", () => {
    assert.deepEqual(apkReleaseCandidates([release("v1", "2026-01-01", ["app.aab", "source.apk.zip"])]), []);
  });
});
