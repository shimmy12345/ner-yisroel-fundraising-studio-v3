export type DonorNavigationOrigin = "donors" | "search" | "today" | "queue" | "recent" | "meeting-brief" | "timeline" | "portfolio-focus" | "fundraising-intelligence";

const ORIGINS = new Set<DonorNavigationOrigin>(["donors", "search", "today", "queue", "recent", "meeting-brief", "timeline", "portfolio-focus", "fundraising-intelligence"]);

export function safeInternalReturnPath(value: string | null | undefined, fallback = "/donors") {
  if (!value || value.length > 2_000 || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const parsed = new URL(value, "https://fundraising-os.invalid");
    if (parsed.origin !== "https://fundraising-os.invalid" || parsed.pathname.startsWith("/api/") || parsed.pathname.startsWith("/auth/")) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function safeDonorOrigin(value: string | null | undefined, returnTo = "/donors"): DonorNavigationOrigin {
  if (value && ORIGINS.has(value as DonorNavigationOrigin)) return value as DonorNavigationOrigin;
  return returnTo.startsWith("/donors?") ? "search" : returnTo.startsWith("/donors") ? "donors" : "today";
}

export function donorNavigationHref(donorId: string, returnTo: string, origin: DonorNavigationOrigin) {
  const query = new URLSearchParams({ from: safeInternalReturnPath(returnTo), origin });
  return `/donors/${encodeURIComponent(donorId)}?${query.toString()}`;
}

export function meetingBriefNavigationHref(donorId: string, returnTo: string, origin: DonorNavigationOrigin) {
  const query = new URLSearchParams({ from: safeInternalReturnPath(returnTo), origin });
  return `/donors/${encodeURIComponent(donorId)}/meeting-brief?${query.toString()}`;
}

export function donorBackLabel(origin: DonorNavigationOrigin) {
  if (origin === "meeting-brief") return "Back to Meeting Brief";
  if (origin === "timeline") return "Back to Timeline";
  if (origin === "portfolio-focus") return "Back to Portfolio Focus";
  if (origin === "fundraising-intelligence") return "Back to Fundraising Intelligence";
  if (origin === "today" || origin === "queue" || origin === "recent") return "Back to Today";
  return "Back to Donors";
}

export function donorDirectoryReturnPath(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (key === "from" || key === "origin") continue;
    for (const value of Array.isArray(raw) ? raw : raw == null ? [] : [raw]) {
      if (value.length <= 200) query.append(key, value);
    }
  }
  const serialized = query.toString();
  return serialized ? `/donors?${serialized}` : "/donors";
}

export function donorDirectorySearchPath(currentPath: string, query: string) {
  const safePath = safeInternalReturnPath(currentPath, "/donors");
  const parsed = new URL(safePath, "https://fundraising-os.invalid");
  if (query.trim()) parsed.searchParams.set("q", query.slice(0, 80)); else parsed.searchParams.delete("q");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

// Geographic Filtering for Travel Planning (2026-10-14) -- same shape
// and convention as donorDirectorySearchPath above, for the directory's
// two new filters (Travel Region, City). A bare value of "all" is
// treated the same as absent (deleted from the URL, never written as
// "?region=all") so the plain, unfiltered "/donors" URL stays the
// common case. Because donorDirectoryReturnPath above already preserves
// every query param except `from`/`origin` generically, these two new
// params round-trip through donor-profile back-navigation automatically
// -- no change needed there.
export function donorDirectoryFilterPath(currentPath: string, updates: { region?: string; city?: string }) {
  const safePath = safeInternalReturnPath(currentPath, "/donors");
  const parsed = new URL(safePath, "https://fundraising-os.invalid");
  if ("region" in updates) { if (updates.region && updates.region !== "all") parsed.searchParams.set("region", updates.region); else parsed.searchParams.delete("region"); }
  if ("city" in updates) { if (updates.city && updates.city !== "all") parsed.searchParams.set("city", updates.city); else parsed.searchParams.delete("city"); }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
