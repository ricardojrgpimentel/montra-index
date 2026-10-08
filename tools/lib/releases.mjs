import { globToRegExp } from "./util.mjs";

/** Releases without APKs must not consume the builder's --deep search window. */
export function apkReleaseCandidates(releases, config = {}) {
  const tagRe = config.tagPattern ? globToRegExp(config.tagPattern) : null;
  return releases
    .filter((release) => !release.draft)
    .filter((release) => config.includePrerelease || !release.prerelease)
    .filter((release) => !tagRe || tagRe.test(release.tag_name))
    .filter((release) => (release.assets ?? []).some((asset) => /\.apk$/i.test(asset.name)))
    .sort((a, b) => new Date(b.published_at ?? 0) - new Date(a.published_at ?? 0));
}
