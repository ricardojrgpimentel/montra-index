// GitHub API access. Uses GITHUB_TOKEN (CI) or the local `gh` CLI session, so builds
// are not limited to 60 requests/hour.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchJson, sleep, log } from "./util.mjs";

const execFileAsync = promisify(execFile);

let cachedToken;
export async function githubToken() {
  if (cachedToken !== undefined) return cachedToken;
  if (process.env.GITHUB_TOKEN) return (cachedToken = process.env.GITHUB_TOKEN);
  if (process.env.GH_TOKEN) return (cachedToken = process.env.GH_TOKEN);
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
    cachedToken = stdout.trim() || null;
    if (cachedToken) log.info("a usar o token do gh CLI para a API do GitHub");
  } catch {
    cachedToken = null;
    log.warn("sem token do GitHub: limite de 60 pedidos/hora (define GITHUB_TOKEN para CI)");
  }
  return cachedToken;
}

export async function githubApi(pathOrUrl, { token, raw = false } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  const auth = token ?? (await githubToken());
  const headers = auth ? { authorization: `Bearer ${auth}` } : {};
  const res = await fetchWithRetryForGithub(url, headers, raw);
  return res;
}

async function fetchWithRetryForGithub(url, headers, raw) {
  const { fetchWithRetry } = await import("./util.mjs");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchWithRetry(url, { headers });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 403 && remaining === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const waitMs = Math.max(1000, Math.min(reset - Date.now(), 65_000));
      log.warn(`rate limit do GitHub atingido; à espera ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status} ${res.statusText} em ${url}${text ? `\n${text.slice(0, 400)}` : ""}`);
    }
    return raw ? res : res.json();
  }
  throw new Error(`GitHub API: rate limit persistente em ${url}`);
}

/** Fetch arbitrary JSON (no GitHub auth headers needed). */
export const fetchPublicJson = (url, options) => fetchJson(url, options);
