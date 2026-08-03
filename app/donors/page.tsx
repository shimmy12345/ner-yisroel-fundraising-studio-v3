import { env } from "cloudflare:workers";
import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { getDataMode } from "../../lib/workspace/mode";
import { DonorDirectorySearch } from "./DonorDirectorySearch";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Relationship = {
  id: string;
  display_name: string;
  primary_first_name: string | null;
  spouse_first_name: string | null;
  spouse: string | null;
  last_name: string | null;
  donor_code: string | null;
  external_id: string | null;
  email: string | null;
  phone: string | null;
  home_phone: string | null;
  alternate_mobile_phone: string | null;
  city: string | null;
  state: string | null;
  external_source: string | null;
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

export default async function DonorsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const identity = await requireChatGPTUser("/donors");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const scope = mode === "demo" ? "data_source = 'sample'" : "owner_user_id = ? AND data_source = 'live'";
  const scopeBinds = mode === "demo" ? [] : [profile.id];
  const query = (await searchParams).q?.trim().slice(0, 80) ?? "";
  const searchFilter = query ? " AND (display_name LIKE ? OR last_name LIKE ? OR primary_first_name LIKE ? OR spouse_first_name LIKE ? OR spouse LIKE ? OR donor_code LIKE ? OR external_id LIKE ? OR email LIKE ? OR phone LIKE ? OR home_phone LIKE ? OR alternate_mobile_phone LIKE ?)" : "";
  const directorySql = `SELECT id, display_name, primary_first_name, spouse_first_name, spouse, last_name, donor_code, external_id, email, phone, home_phone, alternate_mobile_phone, city, state, external_source FROM donors WHERE ${scope}${searchFilter} ORDER BY COALESCE(NULLIF(last_name, ''), display_name) COLLATE NOCASE, display_name COLLATE NOCASE`;
  const result = await env.DB.prepare(directorySql).bind(...scopeBinds, ...(query ? Array(11).fill(`%${query}%`) : [])).all<Relationship>();
  const relationships = result.results;

  return <AppShell active="donors"><main className="donor-directory">
    <header className="directory-heading"><div><p className="eyebrow">RELATIONSHIPS · {mode === "demo" ? "DEMO MODE" : "LIVE WORKSPACE"}</p><h1>Your donor households</h1><p>{query ? `${relationships.length} matching relationship${relationships.length === 1 ? "" : "s"}` : `${relationships.length} relationship${relationships.length === 1 ? "" : "s"} in your workspace`}</p></div><nav className="directory-actions" aria-label="Donor actions">{mode === "live" && <a href="/donors/new">New Donor</a>}<a href="/onboarding/import">Import or refresh data</a></nav></header>
    <DonorDirectorySearch donors={relationships.map((relationship) => ({ id: relationship.id, name: relationship.display_name, lastName: relationship.last_name, spouse: relationship.spouse || relationship.spouse_first_name, code: relationship.external_id || relationship.donor_code, email: relationship.email, phone: relationship.phone || relationship.alternate_mobile_phone || relationship.home_phone }))} />
    {relationships.length ? <section className="directory-list" aria-label="Donor relationships">{relationships.map((relationship) => {
      const members = [relationship.primary_first_name, relationship.spouse_first_name].filter(Boolean).join(" & ");
      const location = [relationship.city, relationship.state].filter(Boolean).join(", ");
      return <a className="directory-row" href={`/donors/${encodeURIComponent(relationship.id)}`} key={relationship.id}>
        <span className="directory-avatar">{initials(relationship.display_name)}</span><span className="directory-identity"><strong>{relationship.display_name}</strong><small>{[members, location].filter(Boolean).join(" · ") || "Relationship details ready to build"}</small></span><span className="directory-contact">{relationship.email || relationship.phone || "No primary contact supplied"}</span>{relationship.external_source && <span className="directory-source">{relationship.external_source === "JL Solutions" ? "JL Solutions" : "Manual"}</span>}<b aria-hidden="true">→</b>
      </a>;
    })}</section> : <section className="directory-empty"><h2>No relationships found</h2><p>{query ? "Try a different household, person, or email." : "Import your donor data to begin building your relationship workspace."}</p>{!query && <a href="/onboarding/import">Import donor data</a>}</section>}
  </main></AppShell>;
}
