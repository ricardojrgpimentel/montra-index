#!/usr/bin/env node
// Recheck the actual APKs after a maintainer edits the proposed entry.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DIRS, indexPathFor, log, sha256File } from "./lib/util.mjs";
import { githubApi } from "./lib/github.mjs";
import { artifactVerificationErrors } from "./lib/proposals.mjs";

const execFileAsync = promisify(execFile);
const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
const pr = event.pull_request;
if (!pr?.head.ref.startsWith("proposals/")) throw new Error("A verificação completa só se aplica a PRs de propostas.");
const files = await githubApi(`/repos/${process.env.GITHUB_REPOSITORY}/pulls/${pr.number}/files?per_page=100`);
if (files.length !== 1 || files[0].status !== "added" || !/^apps\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(files[0].filename)) {
  throw new Error("A proposta tem de adicionar um único ficheiro de app.");
}
const entry = JSON.parse(await fs.readFile(path.join(DIRS.root, files[0].filename), "utf8"));
const before = await sha256File(path.join(DIRS.root, "index.json"));
const signature = await sha256File(path.join(DIRS.root, "index.json.sig"));
const result = await execFileAsync(process.execPath, [path.join(DIRS.root, "tools/build-index.mjs"), "--only", entry.id, "--deep", "3", "--no-icons"], { maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(result.stdout + result.stderr);
const built = JSON.parse(await fs.readFile(indexPathFor(entry.id), "utf8")).apps[0];
const errors = artifactVerificationErrors(entry, built);
if (await sha256File(path.join(DIRS.root, "index.json")) !== before || await sha256File(path.join(DIRS.root, "index.json.sig")) !== signature) errors.push("A verificação alterou o índice publicado.");
if (errors.length) throw new Error(errors.join(" "));
log.ok(`${entry.id}: package, hashes e todos os certificados confirmados sem alterar o catálogo publicado.`);
