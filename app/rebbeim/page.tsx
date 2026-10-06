import { env } from "cloudflare:workers";
import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type RebbiWithCount = { id: string; display_name: string; donor_count: number };

export default async function RebbeimDirectoryPage() {
  const identity = await requireChatGPTUser("/rebbeim");
  const profile = await ensureUserProfile(identity);

  // One pass, no N+1: a single LEFT JOIN + GROUP BY counts every Rebbi's
  // connected LIVE donors at once, matching the ownership scoping every
  // other donor-count query in this app uses.
  const result = await env.DB.prepare(`
    SELECT r.id, r.display_name, COUNT(DISTINCT dr.donor_id) AS donor_count
    FROM rebbeim r
    LEFT JOIN donor_rebbeim dr ON dr.rebbi_id = r.id
    LEFT JOIN donors d ON d.id = dr.donor_id AND d.owner_user_id = r.user_id AND d.data_source = 'live' AND d.archived_at IS NULL
    WHERE r.user_id = ?
    GROUP BY r.id, r.display_name
    ORDER BY r.display_name
  `).bind(profile.id).all<RebbiWithCount>();

  return <AppShell active="donors"><main className="donor-directory">
    <header className="directory-heading"><div><p className="eyebrow">RELATIONSHIPS</p><h1>Rebbeim</h1><p>{result.results.length === 1 ? "1 Rebbi" : `${result.results.length} Rebbeim`} in the canonical directory</p></div><nav className="directory-actions" aria-label="Rebbeim actions"><a href="/donors">Back to donors</a></nav></header>
    {result.results.length === 0
      ? <p className="rebbeim-empty-state">No Rebbeim in the directory yet.</p>
      : <div className="rebbeim-directory-list">
        {result.results.map((rebbi) => <a key={rebbi.id} className="rebbeim-directory-row" href={`/rebbeim/${encodeURIComponent(rebbi.id)}`}>
          <span className="rebbeim-directory-name">{rebbi.display_name}</span>
          <span className="rebbeim-directory-count">{rebbi.donor_count} donor{rebbi.donor_count === 1 ? "" : "s"}</span>
        </a>)}
      </div>}
  </main></AppShell>;
}
