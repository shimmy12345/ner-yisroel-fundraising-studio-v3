import { env } from "cloudflare:workers";
import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { getDataMode } from "../../lib/workspace/mode";

export const dynamic = "force-dynamic";

type Relationship = {
  id: string;
  display_name: string;
  primary_first_name: string | null;
  spouse_first_name: string | null;
  email: string | null;
  phone: string | null;
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
  const result = query
    ? await env.DB.prepare(`SELECT id, display_name, primary_first_name, spouse_first_name, email, phone, city, state, external_source FROM donors WHERE ${scope} AND (display_name LIKE ? OR primary_first_name LIKE ? OR spouse_first_name LIKE ? OR email LIKE ?) ORDER BY display_name COLLATE NOCASE LIMIT 500`).bind(...scopeBinds, ...Array(4).fill(`%${query}%`)).all<Relationship>()
    : await env.DB.prepare(`SELECT id, display_name, primary_first_name, spouse_first_name, email, phone, city, state, external_source FROM donors WHERE ${scope} ORDER BY display_name COLLATE NOCASE LIMIT 500`).bind(...scopeBinds).all<Relationship>();
  const relationships = result.results;

  return <AppShell active="donors"><main className="donor-directory">
    <header className="directory-heading"><div><p className="eyebrow">RELATIONSHIPS · {mode === "demo" ? "DEMO MODE" : "LIVE WORKSPACE"}</p><h1>Your donor households</h1><p>{query ? `${relationships.length} matching relationship${relationships.length === 1 ? "" : "s"}` : `${relationships.length} relationship${relationships.length === 1 ? "" : "s"} in your workspace`}</p></div><a href="/onboarding/import">Import or refresh data</a></header>
    <form className="directory-search" action="/donors" method="get"><label htmlFor="donor-search">Find a household</label><div><input id="donor-search" name="q" type="search" defaultValue={query} placeholder="Search by household, person, or email"/><button type="submit">Search</button>{query && <a href="/donors">Clear</a>}</div></form>
    {relationships.length ? <section className="directory-list" aria-label="Donor relationships">{relationships.map((relationship) => {
      const members = [relationship.primary_first_name, relationship.spouse_first_name].filter(Boolean).join(" & ");
      const location = [relationship.city, relationship.state].filter(Boolean).join(", ");
      return <a className="directory-row" href={`/donors/${encodeURIComponent(relationship.id)}`} key={relationship.id}>
        <span className="directory-avatar">{initials(relationship.display_name)}</span><span className="directory-identity"><strong>{relationship.display_name}</strong><small>{[members, location].filter(Boolean).join(" · ") || "Relationship details ready to build"}</small></span><span className="directory-contact">{relationship.email || relationship.phone || "No primary contact supplied"}</span>{relationship.external_source === "JL Solutions" && <span className="directory-source">JL Solutions</span>}<b aria-hidden="true">→</b>
      </a>;
    })}</section> : <section className="directory-empty"><h2>No relationships found</h2><p>{query ? "Try a different household, person, or email." : "Import your donor data to begin building your relationship workspace."}</p>{!query && <a href="/onboarding/import">Import donor data</a>}</section>}
  </main></AppShell>;
}
