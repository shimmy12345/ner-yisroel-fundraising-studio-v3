import { getChatGPTUser } from "../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../lib/auth/profile";
import { convertProspectToNewDonor } from "../../../../../../../lib/relationships/trips-data";
import type { DonorContactInput } from "../../../../../../../lib/donors/contact";
import { logger } from "../../../../../../../lib/logger";

// Manually Added Prospects (2026-10-25, see docs/AI-HANDOFF.md) -- converts
// an unlinked (not-yet-in-FOS) prospect into a brand-new FOS donor
// account, using the SAME manual-donor-creation shape app/api/donors
// already uses. Never automatic -- this is the one explicit,
// fundraiser-initiated action that creates a donor from this feature.
// Duplicate detection runs first unless the caller already explicitly
// confirmed `force: true` after reviewing the candidates this same
// endpoint returns on a 409.
type ConvertBody = DonorContactInput & { force?: boolean };

export async function POST(request: Request, { params }: { params: Promise<{ id: string; prospectId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, prospectId } = await params;

  let body: ConvertBody;
  try { body = await request.json() as ConvertBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const now = Math.floor(Date.now() / 1000);
  const result = await convertProspectToNewDonor(profile.id, id, prospectId, body, { force: body.force === true }, now);
  if (!result.ok) {
    if (result.reason === "prospect_not_found") return Response.json({ error: "This prospect was not found, or is already linked to a donor." }, { status: 404 });
    if (result.reason === "input_invalid") return Response.json({ error: "Review the highlighted contact details.", fieldErrors: result.fieldErrors }, { status: 422 });
    return Response.json({
      error: "One or more existing donors look like a possible match. Link to one of them instead, or confirm this is a new person.",
      possibleDuplicates: true, candidates: result.candidates,
    }, { status: 409 });
  }
  logger.info("trip_prospect_converted_to_donor", { userId: profile.id, tripId: id, prospectId, donorId: result.donorId });
  return Response.json({ ok: true, donorId: result.donorId }, { status: 201 });
}
