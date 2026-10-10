import { globMatch } from "./util.mjs";
import { inferAbi, slugify } from "./assets.mjs";
import { createHash } from "node:crypto";

export const PROPOSAL_MARKER = "<!-- montra:app-proposal -->";
export const REVIEW_CHECKS = [
  ["license", "Confirmei a licença exata no projeto de origem"],
  ["artifact", "Confirmei a variante do APK e a origem do certificado observado"],
  ["description", "Revi o nome, resumo e descrições em inglês e português"],
  ["category", "Revi as categorias, tags e imagens"],
  ["access", "Confirmei os requisitos de acesso; declarei root/Shizuku e alternativas quando aplicável"],
];

export function selectedRepos(value) {
  const repos = [...new Set(String(value ?? "").split(/[\s,]+/).filter(Boolean).map((r) => r.toLowerCase()))];
  if (!repos.length || repos.length > 5) throw new Error("Escolhe entre 1 e 5 repositórios, separados por vírgulas.");
  for (const repo of repos) {
    if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/.test(repo)) {
      throw new Error(`Repositório inválido: ${repo}. Usa owner/repo.`);
    }
  }
  return repos;
}

export function proposalBranch(repo) {
  selectedRepos(repo);
  const name = repo.toLowerCase();
  return `proposals/${slugify(name)}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

export function proposedLicense(spdx, content, allowed) {
  const explicit = content.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.-]+)/)?.[1];
  if (explicit && allowed.has(explicit)) return explicit;
  // GitHub's GPL-3.0 identification does not prove an "or later" grant.
  const ambiguous = new Set(["GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0"]);
  const candidate = ambiguous.has(spdx) ? `${spdx}-only` : spdx;
  if (!allowed.has(candidate)) throw new Error(`Licença ${spdx ?? "desconhecida"} precisa de revisão manual antes de gerar uma proposta.`);
  return candidate;
}

export function proposedMedia(repo, tree) {
  const images = tree.filter((item) => item.type === "blob" && /\.(png|jpe?g|webp|gif)$/i.test(item.path));
  const roots = ["fastlane/metadata/android/en-US/images/", "metadata/en-US/images/"];
  for (const root of roots) {
    const icon = images.find((item) => new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}icon\\.`, "i").test(item.path));
    const screenshots = images.filter((item) => item.path.startsWith(`${root}phoneScreenshots/`))
      .sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true })).slice(0, 5);
    if (icon || screenshots.length) return {
      ...(icon ? { icon: { repo, path: icon.path } } : {}),
      ...(screenshots.length ? { screenshots: screenshots.map(({ path }) => ({ repo, path })) } : {}),
    };
  }
  return {};
}

function versionPattern(name, versions) {
  for (const version of versions.filter((v) => v && v.length >= 3).sort((a, b) => b.length - a.length)) {
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[-_.])${escaped}(?=$|[-_.])`);
    if (re.test(name)) return name.replace(re, "$1*");
  }
  return name;
}

export function proposedRelease(repo, release, primary, info) {
  const apks = release.assets.filter((asset) => /\.apk$/i.test(asset.name) && !/debug/i.test(asset.name));
  if (!apks.some((asset) => asset.name === primary.name)) throw new Error("A proposta automática não aceita APKs de debug.");
  const versions = [release.tag_name, release.tag_name.replace(/^v/, ""), info.versionName];
  const abi = inferAbi(primary.name);
  const pattern = versionPattern(primary.name, versions);
  // A pattern must select exactly the inspected variant in this release.
  if (apks.filter((asset) => globMatch(pattern, asset.name)).length !== 1) {
    throw new Error("O padrão do APK é ambíguo; escolhe a variante manualmente.");
  }
  const config = { provider: "github", repo, excludePattern: "*debug*" };
  if (!abi || abi === "universal") return { ...config, assetPattern: pattern };
  // Replace only the known ABI token, never the flavour (FOSS/premium/etc.).
  const abiToken = primary.name.match(/arm64-v8a|armeabi-v7a|x86_64|x86|aarch64|armv7|i686|x64/i)?.[0];
  const picks = { [abi]: pattern };
  if (abiToken) {
    for (const asset of apks) {
      const otherAbi = inferAbi(asset.name);
      if (!otherAbi || picks[otherAbi]) continue;
      const token = asset.name.match(/arm64-v8a|armeabi-v7a|x86_64|x86|aarch64|armv7|i686|x64|universal/i)?.[0];
      if (!token || asset.name.replace(token, "{ABI}") !== primary.name.replace(abiToken, "{ABI}")) continue;
      picks[otherAbi] = versionPattern(asset.name, versions);
    }
  }
  return { ...config, abiAssets: picks };
}

export function proposedEntry({ repo, info, license, licenseUrl, media, release, play, now = new Date() }) {
  const name = (info.label || repo.name).replace(/[\r\n]+/g, " ").slice(0, 60);
  const description = repo.description?.trim() || `${name} is an open-source Android app.`;
  return {
    id: slugify(repo.name), name,
    summary: description.replace(/[\r\n]+/g, " ").replace(/\.$/, "").slice(0, 160),
    description: { en: description.slice(0, 4000), pt: "" },
    packageName: info.packageName, license,
    sourceCode: `https://github.com/${repo.full_name}`,
    categories: ["utilities"], tags: [], ...media, release,
    ...(play?.present === true ? { playStore: { present: true, url: play.url } }
      : play?.present === false ? { playStore: { present: false } } : {}),
    addedAt: now.toISOString().slice(0, 10),
    ...(info.minSdk ? { requires: { minSdk: info.minSdk } } : {}),
    verification: {
      signingCertSha256: info.signingCertSha256,
      pinnedAt: now.toISOString().slice(0, 10),
      notes: "Primeiro pin observado no APK oficial; requer confirmação na revisão desta proposta.",
    },
    notes: `Proposta automática a partir de ${repo.full_name}. Licença de referência: ${licenseUrl}. ` +
      "A revisão do mantenedor deve confirmar categorias, textos, imagens, requisitos de acesso e pin antes do merge.",
  };
}

export function markdownText(value) {
  return String(value ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\r\n]+/g, " ").replace(/[\\|`*_[\]]/g, "\\$&");
}

export function proposalBody({ catalogue, branch, entry, built, licenseUrl, warnings = [], runUrl }) {
  const file = `apps/${entry.id}.json`;
  return [
    PROPOSAL_MARKER, `Proposta de **${markdownText(entry.name)}**, preparada a partir dos APKs oficiais.`, "",
    `Este PR é um rascunho. Para o aprovar: [editar a entrada](https://github.com/${catalogue}/edit/${branch}/${file}), ` +
      "completar a descrição portuguesa, rever os restantes campos, marcar a checklist e escolher **Ready for review**. " +
      "Depois de os checks passarem, podes fazer merge. A publicação e assinatura do catálogo acontecem após o merge.", "",
    `Origem: ${entry.sourceCode}`, `Licença a confirmar: ${licenseUrl}`,
    ...(runUrl ? [`Execução de preparação: ${runUrl}`] : []), "",
    `Package: ${markdownText(entry.packageName)}; versão: ${markdownText(built.release.versionName)}.`,
    `Certificado observado e proposto como pin: ${markdownText(entry.verification.signingCertSha256)}.`, "",
    "| ABI | APK oficial | SHA-256 |", "| --- | --- | --- |",
    ...built.release.assets.map((asset) => `| ${markdownText(asset.abi)} | [APK](${asset.url}) | ${asset.sha256} |`), "",
    "Verificado automaticamente: schema, package, hashes e certificado de cada APK selecionado. " +
      "A categoria inicial é genérica; os requisitos de root/Shizuku não são deduzidos de tags. " +
      "A chave privada de assinatura do índice não foi usada nesta preparação.", "",
    "## Revisão do mantenedor", "",
    ...REVIEW_CHECKS.map(([id, text]) => `- [ ] ${text} <!-- montra-review:${id} -->`),
    ...(warnings.length ? ["", "## Pontos a rever", "", ...warnings.map((text) => `- ${markdownText(text)}`)] : []), "",
  ].join("\n");
}

export function proposalReviewErrors(pr, entries) {
  if (!pr.head?.ref?.startsWith("proposals/") && !pr.body?.includes(PROPOSAL_MARKER)) return [];
  const errors = [];
  if (pr.draft) errors.push("Completa a revisão e escolhe Ready for review; esta proposta ainda é um rascunho.");
  for (const [id, text] of REVIEW_CHECKS) {
    if (!new RegExp(`^- \\[[xX]\\] [^\\r\\n]*<!-- montra-review:${id} -->[ \\t]*$`, "m").test(pr.body ?? "")) errors.push(text);
  }
  if (entries.length !== 1) errors.push("Uma proposta deve adicionar exatamente uma app.");
  for (const entry of entries) {
    if (!entry.description?.pt?.trim() || entry.description.pt.trim().length < 8) errors.push("Completa a descrição em português na entrada.");
    if (!entry.description?.en?.trim()) errors.push("Completa a descrição em inglês na entrada.");
    if (!entry.verification?.signingCertSha256) errors.push("A proposta precisa de um pin de certificado.");
  }
  return errors;
}

export function artifactVerificationErrors(entry, built) {
  const errors = [];
  if (built?.packageName !== entry.packageName) errors.push("O package resolvido não corresponde à entrada.");
  const assets = built?.release?.assets ?? [];
  if (!assets.length) errors.push("Nenhum APK foi verificado.");
  for (const asset of assets) {
    if (!asset.signingCertSha256 || asset.signingCertSha256 !== entry.verification?.signingCertSha256) {
      errors.push(`${asset.abi}: certificado não verificado ou diferente do pin da entrada.`);
    }
    if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")) errors.push(`${asset.abi}: hash do APK em falta.`);
  }
  return errors;
}
