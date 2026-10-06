import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";

function csvField(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Simple CSV export for one Rebbi's connected donor list -- useful for
// email/list preparation (see docs/AI-HANDOFF.md's "Donor Rebbeim"
// entry). Deliberately minimal columns; no metrics.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;

  const rebbi = await env.DB.prepare("SELECT id, display_name FROM rebbeim WHERE id=? AND user_id=? LIMIT 1").bind(id, profile.id).first<{ id: string; display_name: string }>();
  if (!rebbi) return Response.json({ error: "Rebbi not found." }, { status: 404 });

  const donors = await env.DB.prepare(`
    SELECT d.donor_code, d.display_name
    FROM donor_rebbeim dr
    JOIN donors d ON d.id = dr.donor_id
    WHERE dr.rebbi_id = ? AND dr.user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL
    ORDER BY d.last_name, d.display_name
  `).bind(id, profile.id).all<{ donor_code: string | null; display_name: string }>();

  const header = "Donor Code,Donor Name,Rebbi";
  const lines = donors.results.map((donor) => [csvField(donor.donor_code ?? ""), csvField(donor.display_name), csvField(rebbi.display_name)].join(","));
  const csv = [header, ...lines].join("\n") + "\n";
  const filename = `${rebbi.display_name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-donors.csv`;
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"` } });
}
