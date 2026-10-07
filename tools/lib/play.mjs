// Google Play lookup, shared by tools/check-play.mjs and tools/discover.mjs.
//
// Play answers 404 for a package that does not exist. For one that does, we read
// the listing name and developer, which doubles as a sanity check that the
// package name we track is really the app we think it is.
import { fetchWithRetry } from "./util.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export async function lookupPlay(packageName) {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=en&gl=US`;
  const res = await fetchWithRetry(url, {
    headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
    tries: 3,
  });
  if (res.status === 404) return { present: false, url };
  if (!res.ok) return { present: null, url, status: res.status, reason: `HTTP ${res.status}` };
  const html = await res.text();
  const name = html.match(/itemprop="name"[^>]*>([^<]*)</)?.[1] ?? null;
  const author = html.match(/"author":\{"@type":"Person","name":"([^"]*)"/)?.[1] ?? null;
  if (!name) return { present: null, url, status: res.status, reason: "sem bloco itemprop=name" };
  return { present: true, url, playName: name, playAuthor: author };
}

/** Loose name comparison, to spot a same-package-name copycat. */
export function nameSimilarity(a, b) {
  const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x.includes(y) || y.includes(x)) return 1;
  let common = 0;
  for (const ch of new Set(x)) if (y.includes(ch)) common++;
  return common / new Set(x).size;
}
