import { notFound } from "next/navigation";
import { env } from "cloudflare:workers";
import { AppShell } from "../../components/AppShell";
import { requireChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ConnectedDonor = { id: string; display_name: string; donor_code: string | null; city: string | null; state: string | null };

export default async function RebbiDonorsPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireChatGPTUser("/rebbeim");
  const profile = await ensureUserProfile(identity);
  const { id } = await params;

  const rebbi = await env.DB.prepare("SELECT id, display_name FROM rebbeim WHERE id=? AND user_id=? LIMIT 1").bind(id, profile.id).first<{ id: string; display_name: string }>();
  if (!rebbi) notFound();

  const donors = await env.DB.prepare(`
    SELECT d.id, d.display_name, d.donor_code, d.city, d.state
    FROM donor_rebbeim dr
    JOIN donors d ON d.id = dr.donor_id
    WHERE dr.rebbi_id = ? AND dr.user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL
    ORDER BY d.last_name, d.display_name
  `).bind(id, profile.id).all<ConnectedDonor>();

  return <AppShell active="donors"><main className="donor-directory">
    <header className="directory-heading"><div><p className="eyebrow">REBBEIM</p><h1>{rebbi.display_name}</h1><p>{donors.results.length} donor{donors.results.length === 1 ? "" : "s"} connected</p></div><nav className="directory-actions" aria-label="Rebbi actions"><a href="/rebbeim">All Rebbeim</a>{donors.results.length > 0 && <a href={`/api/rebbeim/${encodeURIComponent(id)}/export`}>Download CSV</a>}</nav></header>
    {donors.results.length === 0
      ? <p className="rebbeim-empty-state">No donors are currently connected to {rebbi.display_name}.</p>
      : <div className="rebbeim-donor-list">
        {donors.results.map((donor) => <a key={donor.id} className="rebbeim-donor-row" href={`/donors/${encodeURIComponent(donor.id)}`}>
          <span className="rebbeim-donor-name">{donor.display_name}</span>
          <span className="rebbeim-donor-meta">{[donor.donor_code ? `Code ${donor.donor_code}` : null, [donor.city, donor.state].filter(Boolean).join(", ") || null].filter(Boolean).join(" · ")}</span>
        </a>)}
      </div>}
  </main></AppShell>;
}
