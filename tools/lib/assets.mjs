// Working out what a release's APK assets mean.
//
// This logic is shared by tools/build-index.mjs (which resolves what to install)
// and tools/discover.mjs (which proposes an entry for a new app), so there is one
// implementation of "which ABI is this APK" in the project. Getting it wrong means
// offering an arm64 phone an x86 build, so it has tests.

/**
 * Infer the ABI from an asset file name, or null when the name says nothing.
 *
 * Order matters: "arm64" must be checked before the generic arm pattern, and
 * x86_64 before x86.
 */
export function inferAbi(name) {
  const n = name.toLowerCase();
  if (n.includes("arm64") || n.includes("aarch64")) return "arm64-v8a";
  if (n.includes("armeabi") || n.includes("armv7") || /(^|[^a-z0-9])arm([^a-z0-9]|$)/.test(n)) {
    return "armeabi-v7a";
  }
  if (n.includes("x86_64") || n.includes("x64")) return "x86_64";
  if (n.includes("x86") || n.includes("i686")) return "x86";
  if (n.includes("universal") || n.includes("all")) return "universal";
  return null;
}

/**
 * Propose a declarative release config for a release's APK assets.
 *
 * A single APK is an exact assetPattern. Several APKs whose names carry an ABI
 * become abiAssets with one pattern per architecture. Anything else needs a human,
 * and `notes` says so instead of guessing silently.
 */
export function suggestPattern(apks) {
  const notes = [];
  const result = { assetPattern: null, abiAssets: null, primary: null, notes };
  if (!apks || apks.length === 0) return result;

  // Avisado em todos os caminhos, não só num: um store nunca deve indexar uma
  // build de debug, e quem revê tem de o ver independentemente da forma dos nomes.
  const debug = apks.filter((a) => /debug/i.test(a.name));
  if (debug.length) notes.push(`há builds de debug no release: ${debug.map((a) => a.name).join(", ")}`);

  if (apks.length === 1) {
    result.assetPattern = apks[0].name;
    result.primary = apks[0];
    return result;
  }

  const byAbi = new Map();
  let unlabelled = 0;
  for (const apk of apks) {
    const abi = inferAbi(apk.name);
    if (abi === null) unlabelled++;
    if (!byAbi.has(abi)) byAbi.set(abi, []);
    byAbi.get(abi).push(apk);
  }

  if (unlabelled === apks.length) {
    notes.push(`${apks.length} APKs e nenhum nome revela a ABI: precisa de assetPattern/abiAssets à mão`);
    result.assetPattern = "*.apk";
    result.primary = [...apks].sort((a, b) => b.size - a.size)[0];
    return result;
  }

  const abiAssets = {};
  for (const [abi, group] of byAbi) {
    const key = abi ?? "universal";
    if (group.length === 1) {
      // One name per ABI: use it verbatim, so the entry pins the exact file.
      abiAssets[key] = group[0].name;
    } else {
      // Several variants (foss/izzy/github): glob only the version number, so the
      // resulting pattern stays specific about the ABI and the variant.
      abiAssets[key] = group[0].name.replace(/\d+\.\d+(?:\.\d+)?/, "*");
      notes.push(
        `${group.length} variantes para ${key}: ${group.map((a) => a.name).join(", ")} — ` +
          "escolhe a variante certa (foss/izzy/github) e torna o padrão específico",
      );
    }
  }
  result.abiAssets = abiAssets;
  result.primary = byAbi.has("universal")
    ? byAbi.get("universal")[0]
    : [...apks].sort((a, b) => b.size - a.size)[0];
  return result;
}

/** Slug for a new entry's id: stable, lowercase, no accents. */
export function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
