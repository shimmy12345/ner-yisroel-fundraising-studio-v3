import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { extractUniqueJlCodes, extractUniqueJlCodeIdentities, jlCodeIdentitiesToCsv, type JlCodeIdentityRow } from "../../../../lib/import/jl-codes";

export const dynamic = "force-dynamic";

// Convenience export for running updated donation information in JL
// Solutions -- returns only the workspace's own unique JL Codes, scoped to
// the authenticated owner, plus (CSV download only) each code's donor
// First Name/Last Name from the same canonical, structured donor fields
// used everywhere else in this app (never parsed from display_name). No
// email, address, giving amount, note, or unrelated ID is ever selected
// or returned. The plain-codes JSON response below (used by the
// "Copy JL Codes" clipboard feature) is unchanged -- it is a different,
// narrower use case than the file download.
export async function GET(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);

  const rows = await env.DB.prepare(
    "SELECT donor_code, primary_first_name, last_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND donor_code IS NOT NULL"
  ).bind(profile.id).all<JlCodeIdentityRow>();

  if (new URL(request.url).searchParams.get("format") === "csv") {
    const identities = extractUniqueJlCodeIdentities(rows.results);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return new Response(jlCodeIdentitiesToCsv(identities), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="fundraising-os-jl-codes-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  const codes = extractUniqueJlCodes(rows.results.map((row) => row.donor_code));
  return Response.json({ codes, count: codes.length }, { headers: { "cache-control": "no-store" } });
}
