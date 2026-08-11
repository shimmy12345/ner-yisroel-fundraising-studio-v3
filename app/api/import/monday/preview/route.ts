import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { getDataMode } from "../../../../../lib/workspace/mode";
import { numericDonorCode } from "../../../../../lib/relationships/donor-identity";
import { buildMondayPreview, type MondayDonorLookup } from "../../../../../lib/import/monday-pipeline";
import type { MondayDonorBlock } from "../../../../../lib/import/monday-workbook";
import { logger } from "../../../../../lib/logger";

// The .xlsx itself is parsed client-side (parseMondayWorkbook is an
// isomorphic pure module -- no Node-only APIs) so only the already-parsed
// donor blocks travel over the wire. This route's only job is the one
// thing that has to happen server-side: matching Monday's Code against
// this owner's live donor records. No outbound network call, no write --
// preview only.
type Body = { donorBlocks?: MondayDonorBlock[] };
type DonorRow = { id: string; display_name: string; donor_code: string | null; external_id: string | null };

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  if (mode !== "live") return Response.json({ error: "Historical import is only available in your live workspace." }, { status: 422 });

  const body = await request.json().catch(() => null) as Body | null;
  if (!body?.donorBlocks || !Array.isArray(body.donorBlocks) || body.donorBlocks.length === 0) {
    return Response.json({ error: "No donor rows were found in that file." }, { status: 422 });
  }

  try {
    const donors = await env.DB.prepare("SELECT id, display_name, donor_code, external_id FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(profile.id).all<DonorRow>();
    const lookup: MondayDonorLookup = new Map();
    for (const row of donors.results) {
      const code = numericDonorCode({ donorCode: row.donor_code, externalId: row.external_id });
      if (code) lookup.set(code, { id: row.id, displayName: row.display_name });
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    const rows = buildMondayPreview(body.donorBlocks, lookup, todayIso);
    logger.info("monday_import_previewed", { userId: profile.id, donorCount: body.donorBlocks.length, rowCount: rows.length });
    return Response.json({ rows });
  } catch (error) {
    logger.error("monday_import_preview_failed", error, { userId: profile.id });
    return Response.json({ error: "That file could not be read as a Monday.com pipeline export." }, { status: 422 });
  }
}
