import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { extractUniqueJlCodes, jlCodesToCsv } from "../../../../lib/import/jl-codes";

export const dynamic = "force-dynamic";

// Convenience export for running updated donation information in JL
// Solutions -- returns only the workspace's own unique JL Codes, scoped to
// the authenticated owner. No donor name, email, address, giving amount,
// note, or unrelated ID is ever selected or returned.
export async function GET(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);

  const rows = await env.DB.prepare(
    "SELECT donor_code FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND donor_code IS NOT NULL"
  ).bind(profile.id).all<{ donor_code: string | null }>();
  const codes = extractUniqueJlCodes(rows.results.map((row) => row.donor_code));

  if (new URL(request.url).searchParams.get("format") === "csv") {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return new Response(jlCodesToCsv(codes), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="fundraising-os-jl-codes-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  return Response.json({ codes, count: codes.length }, { headers: { "cache-control": "no-store" } });
}
