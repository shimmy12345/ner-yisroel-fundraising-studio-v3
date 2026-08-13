import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { getDataMode } from "../../../../../lib/workspace/mode";
import { numericDonorCode } from "../../../../../lib/relationships/donor-identity";
import { buildYahrtzeitPreview, type YahrtzeitDonorLookup } from "../../../../../lib/import/yahrtzeit-pipeline.ts";
import type { YahrtzeitWorkbookRow } from "../../../../../lib/import/yahrtzeit-workbook.ts";
import { logger } from "../../../../../lib/logger";

// Same shape as the Monday.com importer: the .xlsx itself is parsed
// client-side (parseYahrtzeitWorkbook is isomorphic -- no Node-only APIs),
// so only the already-parsed rows travel over the wire. This route does
// the one thing that has to happen server-side: matching Code against this
// owner's live donor records, exact match only. Read-only -- preview only.
type Body = { rows?: YahrtzeitWorkbookRow[] };
type DonorRow = { id: string; display_name: string; donor_code: string | null; external_id: string | null };

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  if (mode !== "live") return Response.json({ error: "Yahrtzeit import is only available in your live workspace." }, { status: 422 });

  const body = await request.json().catch(() => null) as Body | null;
  if (!body?.rows || !Array.isArray(body.rows) || body.rows.length === 0) {
    return Response.json({ error: "No rows were found in that file." }, { status: 422 });
  }

  try {
    const donors = await env.DB.prepare("SELECT id, display_name, donor_code, external_id FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(profile.id).all<DonorRow>();
    const lookup: YahrtzeitDonorLookup = new Map();
    for (const row of donors.results) {
      const code = numericDonorCode({ donorCode: row.donor_code, externalId: row.external_id });
      if (code) lookup.set(code, { donorId: row.id, donorName: row.display_name });
    }
    const now = Math.floor(Date.now() / 1000);
    const preview = buildYahrtzeitPreview(body.rows, lookup, profile.timezone, now);
    logger.info("yahrtzeit_import_previewed", { userId: profile.id, rowCount: preview.length, matchedCount: preview.filter((row) => row.matchedDonorId).length });
    return Response.json({ rows: preview });
  } catch (error) {
    logger.error("yahrtzeit_import_preview_failed", error, { userId: profile.id });
    return Response.json({ error: "That file could not be read as a Yahrtzeit workbook." }, { status: 422 });
  }
}
