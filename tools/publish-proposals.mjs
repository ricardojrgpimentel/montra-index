#!/usr/bin/env node
// Only this publisher needs write access; APK inspection uses a read-only job.
// It writes one new apps/*.json file on a separate branch and opens a draft PR.
import fs from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { DIRS, log, writeJson } from "./lib/util.mjs";
import { githubApi, githubToken } from "./lib/github.mjs";
import { selectedRepos, proposalBranch, PROPOSAL_MARKER, markdownText } from "./lib/proposals.mjs";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Uso: node tools/publish-proposals.mjs manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const catalogue = process.env.GITHUB_REPOSITORY;
selectedRepos(catalogue);
if (!catalogue || manifest.catalogue !== catalogue || manifest.version !== 1) throw new Error("Manifesto para um repositório inesperado.");
if (!Array.isArray(manifest.proposals) || manifest.proposals.length > 5) throw new Error("O manifesto excede o limite de propostas.");
const token = await githubToken();
if (!token) throw new Error("Token em falta.");
const owner = catalogue.split("/")[0];
const prefix = `/repos/${catalogue}`;
const results = { created: [], skipped: [...(manifest.skipped ?? [])], failed: [...(manifest.failed ?? [])] };
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(await fs.readFile(path.join(DIRS.schema, "app.schema.json"), "utf8")));

async function writeApi(endpoint, body) {
  const res = await fetch(`https://api.github.com${prefix}${endpoint}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/vnd.github+json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json()).message ?? "falha ao publicar proposta"}`);
  return res.json();
}

async function exists(endpoint) {
  try { await githubApi(`${prefix}${endpoint}`); return true; }
  catch (error) { if (error.message.includes("GitHub API 404 ")) return false; throw error; }
}

for (const proposal of manifest.proposals ?? []) {
  try {
    const { entry, branch, repo, body, built } = proposal;
    if (!validate(entry) || branch !== proposalBranch(repo) || entry.release.repo !== repo ||
        entry.sourceCode !== `https://github.com/${repo}` || !body.includes(PROPOSAL_MARKER) || !entry.verification?.signingCertSha256 ||
        built?.packageName !== entry.packageName || !built.release?.assets?.length ||
        built.release.assets.some((asset) => asset.signingCertSha256 !== entry.verification.signingCertSha256 || !/^[a-f0-9]{64}$/.test(asset.sha256))) {
      throw new Error("Proposta inválida; só são permitidas entradas novas verificadas e branches proposals/.");
    }
    const prior = await githubApi(`${prefix}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all`);
    if (prior.length) {
      results.skipped.push({ repo, reason: "proposta existente; não alterar decisões ou edições anteriores", url: prior[0].html_url }); continue;
    }
    const file = `apps/${entry.id}.json`;
    if (await exists(`/contents/${file}?ref=main`)) throw new Error(`${file} já existe em main; não será substituído.`);
    if (await exists(`/git/ref/heads/${branch}`)) throw new Error(`Branch ${branch} já existe sem PR; revê-a antes de repetir a preparação.`);
    const base = await githubApi(`${prefix}/git/ref/heads/main`);
    const parent = await githubApi(`${prefix}/git/commits/${base.object.sha}`);
    const blob = await writeApi("/git/blobs", { encoding: "utf-8", content: JSON.stringify(entry, null, 2) + "\n" });
    const tree = await writeApi("/git/trees", { base_tree: parent.tree.sha, tree: [{ path: file, mode: "100644", type: "blob", sha: blob.sha }] });
    const commit = await writeApi("/git/commits", { message: `Propor ${entry.name} para o catálogo`, tree: tree.sha, parents: [base.object.sha] });
    await writeApi("/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha });
    const pr = await writeApi("/pulls", { title: `Adicionar ${entry.name} ao catálogo`, head: branch, base: "main", draft: true, body });
    results.created.push({ repo, url: pr.html_url, number: pr.number });
    log.ok(`${repo}: ${pr.html_url}`);
  } catch (error) {
    results.failed.push({ repo: proposal.repo, reason: String(error.message) });
    log.error(`${proposal.repo}: ${error.message}`);
  }
}
await writeJson(path.join(path.dirname(manifestPath), "published.json"), results);
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ["# Propostas de apps", "", ...results.created.map((p) => `- [${p.repo}](${p.url}) — PR em rascunho, pronto para completar a revisão.`),
    ...results.skipped.map((p) => `- ${p.repo}: ${p.reason}${p.url ? ` — ${p.url}` : ""}`),
    ...results.failed.map((p) => `- Falha em ${markdownText(p.repo)}: ${markdownText(p.reason)}`), ""];
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
}
if (results.failed.length) process.exitCode = 1;
