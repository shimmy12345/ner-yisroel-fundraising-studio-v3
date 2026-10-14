import { env } from "cloudflare:workers";
import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { getDataMode } from "../../lib/workspace/mode";
import { donorDirectoryReturnPath } from "../../lib/navigation/donor-navigation";
import { DonorDirectoryPosition } from "../components/DonorNavigation";
import { DonorDirectoryExperience, type DirectoryRelationship } from "./DonorDirectoryExperience";
import { ALL_REGIONS, type RegionFilterValue } from "../../lib/relationships/donor-geo-filter";
import { travelRegionById } from "../../lib/relationships/travel-regions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DonorsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireChatGPTUser("/donors");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const scope = mode === "demo" ? "data_source = 'sample'" : "owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL";
  const scopeBinds = mode === "demo" ? [] : [profile.id];
  const requestedParams = await searchParams;
  const rawQuery = Array.isArray(requestedParams.q) ? requestedParams.q[0] : requestedParams.q;
  const query = rawQuery?.trim().slice(0, 80) ?? "";
  // Geographic Filtering for Travel Planning (2026-10-14) -- an unknown
  // or stale `?region=` value (e.g. a bookmarked link from before a
  // region was renamed) falls back to "All Regions" rather than ever
  // throwing or silently matching nothing; `city` has no fixed id space
  // to validate against (it's just a cityStateKey() match against
  // whatever donors actually exist), so it passes through as-is and a
  // key matching zero current donors simply shows zero results, exactly
  // like a free-text search with no matches.
  const rawRegion = Array.isArray(requestedParams.region) ? requestedParams.region[0] : requestedParams.region;
  const initialRegion: RegionFilterValue = (rawRegion && travelRegionById(rawRegion)) ? (rawRegion as RegionFilterValue) : ALL_REGIONS;
  const rawCity = Array.isArray(requestedParams.city) ? requestedParams.city[0] : requestedParams.city;
  const initialCity = rawCity?.trim().slice(0, 200) || "all";
  const returnPath = donorDirectoryReturnPath(requestedParams);
  const directorySql = `SELECT id, display_name, primary_first_name, spouse_first_name, spouse, last_name, donor_code, external_id, email, phone, home_phone, alternate_mobile_phone, city, state, external_source FROM donors WHERE ${scope}`;
  const result = await env.DB.prepare(directorySql).bind(...scopeBinds).all<DirectoryRelationship>();

  return <AppShell active="donors"><main className="donor-directory">
    <DonorDirectoryPosition returnPath={returnPath} />
    <header className="directory-heading"><div><p className="eyebrow">RELATIONSHIPS · {mode === "demo" ? "DEMO MODE" : "LIVE WORKSPACE"}</p><h1>Your donor households</h1><p>{result.results.length} relationship{result.results.length === 1 ? "" : "s"} in your workspace</p></div><nav className="directory-actions" aria-label="Donor actions">{mode === "live" && <a href="/donors/new">New Donor</a>}<a href="/rebbeim">Rebbeim</a><a href="/onboarding/import">Import or refresh data</a></nav></header>
    <DonorDirectoryExperience relationships={result.results} initialQuery={query} initialReturnPath={returnPath} initialRegion={initialRegion} initialCity={initialCity} />
  </main></AppShell>;
}
