#!/usr/bin/env node
// A generated draft needs human curation before its PR can pass validation.
import fs from "node:fs/promises";
import path from "node:path";
import { DIRS, log } from "./lib/util.mjs";
import { githubApi } from "./lib/github.mjs";
import { PROPOSAL_MARKER, proposalReviewErrors } from "./lib/proposals.mjs";

const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
const number = event.pull_request?.number;
if (!number) { log.info("Sem pull request: revisão de propostas não aplicável."); }
else {
  // Fetch the current PR: checkbox edits may have happened after the run started.
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = await githubApi(`/repos/${repo}/pulls/${number}`);
  if (!pr.head.ref.startsWith("proposals/") && !pr.body?.includes(PROPOSAL_MARKER)) {
    log.info("PR normal: revisão automática de propostas não aplicável.");
  } else {
    const files = await githubApi(`/repos/${repo}/pulls/${number}/files?per_page=100`);
    const errors = [];
    if (files.length !== 1 || files.some((file) => file.status !== "added" || !/^apps\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(file.filename))) {
      errors.push("Uma proposta deve adicionar um único ficheiro apps/<id>.json, sem alterar entradas existentes ou ferramentas.");
    }
    const entries = [];
    for (const file of files.filter((file) => /^apps\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(file.filename))) {
      entries.push(JSON.parse(await fs.readFile(path.join(DIRS.root, file.filename), "utf8")));
    }
    errors.push(...proposalReviewErrors(pr, entries));
    for (const error of errors) log.error(error);
    if (errors.length) process.exitCode = 1;
    else log.ok("Proposta revista pelo mantenedor e pronta para aprovação.");
  }
}
