// Shared helpers for the OpenShelf index tooling. No dependencies beyond node: builtins.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DIRS = {
  root: ROOT,
  apps: path.join(ROOT, "apps"),
  schema: path.join(ROOT, "schema"),
  icons: path.join(ROOT, "icons"),
  screenshots: path.join(ROOT, "screenshots"),
  cache: path.join(ROOT, ".cache"),
  keys: path.join(ROOT, "keys"),
  out: ROOT,
};

/* ------------------------------------------------------------------ logging */
const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = {
  bold: c("1"), dim: c("2"), red: c("31"), green: c("32"),
  yellow: c("33"), blue: c("34"), magenta: c("35"), cyan: c("36"),
};
export const log = {
  step: (m) => console.log(`${color.cyan("→")} ${m}`),
  ok: (m) => console.log(`${color.green("✓")} ${m}`),
  warn: (m) => console.log(`${color.yellow("!")} ${m}`),
  error: (m) => console.error(`${color.red("✗")} ${m}`),
  info: (m) => console.log(`${color.dim("·")} ${m}`),
};

export function fail(message, code = 1) {
  log.error(message);
  process.exit(code);
}

/* --------------------------------------------------------------------- json */
export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function writeJson(file, value, { compact = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(file, text, "utf8");
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------- glob */
/** Minimal glob -> RegExp. Supports *, ? and **. Case-insensitive: upstream asset naming is inconsistent. */
export function globToRegExp(pattern, { caseInsensitive = true } = {}) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? "i" : "");
}

export function globMatch(pattern, value) {
  return globToRegExp(pattern).test(value);
}

export function globFilter(pattern, values) {
  if (!pattern) return values;
  const re = globToRegExp(pattern);
  return values.filter((v) => re.test(v));
}

/* ------------------------------------------------------------------- hashing */
export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function sha256File(file) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function shortHash(hex, groups = 4) {
  return hex.slice(0, groups * 2).match(/.{2}/g).join(":");
}

/** "AA:BB:.." (32 bytes) -> lowercase hex, and back. */
export function colonToHex(colon) {
  return colon.replace(/:/g, "").toLowerCase();
}
export function hexToColon(hex) {
  return hex.toLowerCase().match(/.{2}/g).join(":");
}

/* ------------------------------------------------------------------- network */
const DEFAULT_HEADERS = {
  "user-agent": "openshelf-index-bot (+https://github.com/openshelf)",
  accept: "application/vnd.github+json, application/json;q=0.9, */*;q=0.8",
  "x-github-api-version": "2022-11-28",
};

export async function fetchWithRetry(url, { headers = {}, tries = 4, method = "GET", body } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { method, headers: { ...DEFAULT_HEADERS, ...headers }, body, redirect: "follow" });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        lastError = new Error(`HTTP ${res.status} for ${url}`);
        if (attempt < tries) {
          log.warn(`HTTP ${res.status} em ${url} — nova tentativa em ${Math.round(waitMs / 1000)}s`);
          await sleep(waitMs);
          continue;
        }
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < tries) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}

export async function fetchJson(url, options) {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download to a URL-addressed cache, so repeated builds and CI re-runs do not
 * re-fetch hundreds of megabytes of APKs. Returns the cached file path.
 */
export async function downloadCached(url, { subdir = "files", filename, token, onProgress } = {}) {
  const digest = createHash("sha1").update(url).digest("hex").slice(0, 16);
  const safeName = (filename ?? path.basename(new URL(url).pathname)) || "download.bin";
  const dir = path.join(DIRS.cache, subdir);
  const target = path.join(dir, `${digest}-${safeName}`);
  if (await exists(target)) {
    const stat = await fs.stat(target);
    if (stat.size > 0) {
      onProgress?.({ cached: true, received: stat.size, total: stat.size });
      return target;
    }
  }
  await fs.mkdir(dir, { recursive: true });
  const headers = token ? { authorization: `Bearer ${token}`, accept: "application/octet-stream" } : {};
  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao descarregar ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const tmp = `${target}.part`;
  const out = (await import("node:fs")).createWriteStream(tmp);
  const source = Readable.fromWeb(res.body);
  source.on("data", (chunk) => {
    received += chunk.length;
    onProgress?.({ cached: false, received, total });
  });
  await pipeline(source, out);
  await fs.rename(tmp, target);
  return target;
}

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function progressBar({ received, total }) {
  if (!total) return humanBytes(received);
  const pct = Math.floor((received / total) * 100);
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${pct}% ${humanBytes(received)}/${humanBytes(total)}`;
}

/** os.availableParallelism-ish pool. Keeps GitHub API and disk usage civil. */
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
