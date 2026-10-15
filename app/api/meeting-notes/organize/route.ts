import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { logger } from "../../../../lib/logger";
import { organizeMeetingNotes, DEFAULT_ANTHROPIC_MODEL, MAX_TRANSCRIPT_LENGTH } from "../../../../lib/meeting-notes/organize";

type RequestBody = { donorId?: string; transcript?: string };

// Never writes anything -- read of the donor (for the ownership check) and
// an outbound call to Anthropic only. Still fully auth-gated and
// donor-ownership-checked like every mutating route in this app: this
// receives a donor's confidential meeting content and spends a (currently
// inert, pending separate approval) paid API call, neither of which an
// unauthenticated or cross-donor request may trigger.
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const donorId = body.donorId ?? "";
  const transcript = body.transcript?.trim() ?? "";
  if (!donorId || transcript.length === 0) {
    return Response.json({ error: "A donor and meeting text are required" }, { status: 422 });
  }
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
    return Response.json({ error: `Meeting text is too long (max ${MAX_TRANSCRIPT_LENGTH} characters)` }, { status: 422 });
  }

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const ownedDonor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").bind(donorId, userId).first<{ id: string }>();
  if (!ownedDonor) return Response.json({ error: "Donor not found" }, { status: 404 });

  // Deliberately NOT an error response -- "AI organization isn't
  // configured yet" is an expected, disclosed state (see this feature's
  // authorization boundary in docs/AI-HANDOFF.md) that the client renders
  // as a plain notice, with manual save remaining fully available.
  if (!env.ANTHROPIC_API_KEY) {
    logger.info("meeting_notes_organize_unavailable", { donorId, userId });
    return Response.json({ available: false });
  }

  const result = await organizeMeetingNotes({
    transcript,
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
  });

  // Never log transcript content, the AI's response content, or the API
  // key -- only that an attempt happened and whether it succeeded.
  logger.info("meeting_notes_organize_attempted", { donorId, userId, ok: result.ok });
  if (!result.ok) return Response.json({ available: true, ok: false, error: result.error });
  return Response.json({ available: true, ok: true, data: result.data });
}
