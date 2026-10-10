import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectedRepos, proposalBranch, proposedLicense, proposedMedia, proposedRelease,
  proposedEntry, proposalBody, proposalReviewErrors, artifactVerificationErrors, PROPOSAL_MARKER, REVIEW_CHECKS } from "./proposals.mjs";

const signed = { packageName: "dev.example.app", label: "Example", versionName: "1.2.3", minSdk: 26, signingCertSha256: "aa:bb" };
const release = { tag_name: "v1.2.3", assets: [
  { name: "App-v1.2.3-arm64-v8a-foss.apk" }, { name: "App-v1.2.3-x86_64-foss.apk" },
  { name: "App-v1.2.3-arm64-v8a-premium.apk" }, { name: "App-v1.2.3-arm64-v8a-debug.apk" },
] };

describe("selected app proposals", () => {
  it("bounds selections and rejects URLs, paths and shell text", () => {
    assert.deepEqual(selectedRepos("Owner/App,owner/app\nother/project"), ["owner/app", "other/project"]);
    for (const invalid of ["", "https://github.com/owner/app", "owner/app/../../tools", "owner/$(command)", "a/a,b/b,c/c,d/d,e/e,f/f"]) {
      assert.throws(() => selectedRepos(invalid));
    }
    assert.match(proposalBranch("Owner/App"), /^proposals\/[a-z0-9-]+-[a-f0-9]{8}$/);
    assert.equal(proposalBranch("Owner/App"), proposalBranch("owner/app"));
    assert.notEqual(proposalBranch("owner/a.b"), proposalBranch("owner/a-b"));
    assert.notEqual(proposalBranch("one/app"), proposalBranch("two/app"));
  });

  it("does not invent an or-later licence grant", () => {
    const allowed = new Set(["GPL-3.0-only", "GPL-3.0-or-later", "MIT"]);
    assert.equal(proposedLicense("GPL-3.0", "GNU GPL text", allowed), "GPL-3.0-only");
    assert.equal(proposedLicense("GPL-3.0", "SPDX-License-Identifier: GPL-3.0-or-later", allowed), "GPL-3.0-or-later");
    assert.equal(proposedLicense("MIT", "MIT text", allowed), "MIT");
    assert.throws(() => proposedLicense("NOASSERTION", "", allowed));
  });

  it("keeps FOSS separate from premium and debug while generalising the version", () => {
    const result = proposedRelease("owner/app", release, release.assets[0], signed);
    assert.deepEqual(result.abiAssets, { "arm64-v8a": "App-*-arm64-v8a-foss.apk", x86_64: "App-*-x86_64-foss.apk" });
    assert.equal(result.excludePattern, "*debug*");
    assert.throws(() => proposedRelease("owner/app", release, release.assets[3], signed), /debug/);
    assert.throws(() => proposedRelease("owner/app", { ...release, assets: [release.assets[0], release.assets[0]] }, release.assets[0], signed), /ambíguo/);
  });

  it("uses an exact pattern when the filename does not contain a known version", () => {
    const asset = { name: "App-release.apk" };
    assert.equal(proposedRelease("owner/app", { ...release, assets: [asset] }, asset, signed).assetPattern, "App-release.apk");
  });

  it("uses supported fastlane images and limits screenshots without selecting source resources", () => {
    const tree = ["fastlane/metadata/android/en-US/images/icon.png", "fastlane/metadata/android/en-US/images/icon.svg",
      ...[6, 4, 3, 1, 5, 2].map((n) => `fastlane/metadata/android/en-US/images/phoneScreenshots/${n}.jpg`), "app/src/icon.png"]
      .map((path) => ({ path, type: "blob" }));
    const result = proposedMedia("owner/app", tree);
    assert.equal(result.icon.path, "fastlane/metadata/android/en-US/images/icon.png");
    assert.equal(result.screenshots.length, 5);
    assert.match(result.screenshots[0].path, /1\.jpg$/);
    assert.deepEqual(proposedMedia("owner/app", [{ path: "app/src/icon.png", type: "blob" }]), {});
  });

  it("keeps human translation and access decisions explicit", () => {
    const entry = proposedEntry({ repo: { name: "App", full_name: "owner/App", description: "An Android app." }, info: signed,
      license: "MIT", licenseUrl: "https://github.com/owner/App/blob/v1/LICENSE", media: {}, release: { provider: "github", repo: "owner/App" },
      play: { present: null }, now: new Date("2026-10-10T00:00:00Z") });
    assert.equal(entry.description.pt, "");
    assert.equal(entry.accessRequirements, undefined);
    assert.equal(entry.playStore, undefined);
    assert.equal(entry.summary, "An Android app");
    assert.equal(entry.verification.signingCertSha256, signed.signingCertSha256);
  });

  it("requires a non-draft PR, every review decision and a Portuguese description", () => {
    const body = [PROPOSAL_MARKER, ...REVIEW_CHECKS.map(([id, text]) => `- [x] ${text} <!-- montra-review:${id} -->`)].join("\n");
    const pr = { draft: false, head: { ref: "proposals/example" }, body };
    const entry = { description: { en: "An app", pt: "Uma app Android útil" }, verification: { signingCertSha256: "aa:bb" } };
    assert.deepEqual(proposalReviewErrors(pr, [entry]), []);
    assert.ok(proposalReviewErrors({ ...pr, draft: true }, [entry]).length);
    assert.ok(proposalReviewErrors({ ...pr, body: body.replace("[x]", "[ ]") }, [entry]).length);
    assert.ok(proposalReviewErrors({ ...pr, body: "" }, [entry]).length);
    assert.ok(proposalReviewErrors(pr, [{ ...entry, description: { en: "An app", pt: "" } }]).length);
    assert.ok(proposalReviewErrors(pr, []).length);
    assert.deepEqual(proposalReviewErrors({ draft: false, head: { ref: "normal" }, body: "Normal PR" }, []), []);
  });

  it("makes missing curation visible without injecting upstream Markdown", () => {
    const body = proposalBody({ catalogue: "owner/index", branch: "proposals/example", entry: {
      id: "app", name: "<script>|[fake]", sourceCode: "https://github.com/owner/app", packageName: "dev.example.app",
      verification: { signingCertSha256: "aa:bb" },
    }, built: { release: { versionName: "1.2.3", assets: [] } }, licenseUrl: "https://github.com/owner/app/blob/main/LICENSE" });
    assert.ok(body.includes(PROPOSAL_MARKER));
    assert.ok(body.includes("Ready for review"));
    assert.ok(body.includes("completar a descrição portuguesa"));
    assert.ok(!body.includes("<script>"));
    assert.ok(body.includes("&lt;script&gt;"));
    assert.ok(body.includes("montra-review:access"));
  });

  it("requires every ABI to have a matching verified certificate, not just one", () => {
    const entry = { packageName: "dev.example.app", verification: { signingCertSha256: "aa:bb" } };
    const asset = { abi: "arm64-v8a", sha256: "a".repeat(64), signingCertSha256: "aa:bb" };
    const built = { packageName: entry.packageName, release: { assets: [asset] } };
    assert.deepEqual(artifactVerificationErrors(entry, built), []);
    assert.ok(artifactVerificationErrors(entry, { ...built, release: { assets: [asset, { ...asset, abi: "x86", signingCertSha256: null }] } }).length);
    assert.ok(artifactVerificationErrors(entry, { ...built, release: { assets: [{ ...asset, signingCertSha256: "cc:dd" }] } }).length);
    assert.ok(artifactVerificationErrors(entry, { ...built, packageName: "dev.premium.app" }).length);
    assert.ok(artifactVerificationErrors(entry, { ...built, release: { assets: [] } }).length);
    assert.ok(artifactVerificationErrors(entry, { ...built, release: { assets: [{ ...asset, sha256: null }] } }).length);
  });
});
