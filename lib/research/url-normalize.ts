// Dedup key for donor_research_sources.normalized_url -- strips tracking
// parameters and trailing-slash/case noise so the same page pasted twice,
// or pasted again months later with a different campaign tag, resolves to
// one durable source row instead of a duplicate.
const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_NAMES = new Set(["gclid", "fbclid", "msclkid", "ref", "ref_src", "igshid", "mc_cid", "mc_eid"]);

export function extractDomain(rawUrl: string): string {
  return new URL(rawUrl).hostname.toLowerCase();
}

export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const kept = new URLSearchParams();
  const pairs = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of pairs) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix)) || TRACKING_PARAM_NAMES.has(lower)) continue;
    kept.append(key, value);
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const search = kept.toString();
  return `${url.protocol}//${url.hostname.toLowerCase()}${path}${search ? `?${search}` : ""}`;
}
