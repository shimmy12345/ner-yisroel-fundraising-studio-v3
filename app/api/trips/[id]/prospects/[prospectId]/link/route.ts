import { getChatGPTUser } from "../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../lib/auth/profile";
import { linkProspectToDonor } from "../../../../../../../lib/relationships/trips-data";
import { logger } from "../../../../../../../lib/logger";

// Manually Added Prospects (2026-10-25, see docs/AI-HANDOFF.md) -- links
// an unlinked (not-yet-in-FOS) prospect to an EXISTING FOS donor
// account. Never creates or modifies a donor record; preserves this
// trip_prospects row's own id, status, meeting history, and any
// unlinked fundraising commitments (migrated onto the now-known donor,
// never duplicated -- see trips-data.ts's migrateProspectCommitments).
type LinkBody = { donorId?: string };

export async function POST(request: Request, { params }: { params: Promise<{ id: string; prospectId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, prospectId } = await params;

  let body: LinkBody;
  try { body = await request.json() as LinkBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
  if (!body.donorId) return Response.json({ error: "Choose a donor to link." }, { status: 422 });

  const now = Math.floor(Date.now() / 1000);
  const result = await linkProspectToDonor(profile.id, id, prospectId, body.donorId, now);
  if (!result.ok) {
    if (result.reason === "prospect_not_found") return Response.json({ error: "This prospect was not found, or is already linked to a donor." }, { status: 404 });
    if (result.reason === "donor_not_found") return Response.json({ error: "Donor not found." }, { status: 404 });
    return Response.json({ error: "That donor already has its own prospect entry on this trip. Remove the duplicate first." }, { status: 409 });
  }
  logger.info("trip_prospect_linked_to_donor", { userId: profile.id, tripId: id, prospectId, donorId: body.donorId });
  return Response.json({ ok: true });
}
