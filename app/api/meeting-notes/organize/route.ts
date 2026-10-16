import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { logger } from "../../../../lib/logger";
import { MAX_TRANSCRIPT_LENGTH, type OrganizeResult } from "../../../../lib/meeting-notes/organize";
import { organizeWithWorkersAI, DEFAULT_WORKERS_AI_MODEL } from "../../../../lib/meeting-notes/providers/workers-ai";
import { organizeWithAnthropic, DEFAULT_ANTHROPIC_MODEL } from "../../../../lib/meeting-notes/providers/anthropic";
import { selectMeetingNotesProvider } from "../../../../lib/meeting-notes/provider-selection";

type RequestBody = { donorId?: string; transcript?: string };

// Never writes anything -- read of the donor (for the ownership check) and
// an outbound AI call only (Workers AI binding by default, or Anthropic if
// explicitly configured). Still fully auth-gated and donor-ownership-
// checked like every mutating route in this app: this receives a donor's
// confidential meeting content, which neither an unauthenticated nor a
// cross-donor request may trigger.
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

  // Provider selection is config-only (AI_PROVIDER var) -- no code change
  // needed to switch. "workers-ai" is the default (also used if the var
  // is absent or set to anything else) per docs/AI-HANDOFF.md's "Evaluate
  // Cloudflare Workers AI as an Alternative to Anthropic" recommendation;
  // "anthropic" stays available as a configurable, currently inactive
  // alternative (no ANTHROPIC_API_KEY is configured anywhere as of this
  // round, so selecting it today still reports "unavailable" below).
  const provider = selectMeetingNotesProvider(env.AI_PROVIDER);

  let result: OrganizeResult;
  if (provider === "anthropic") {
    // Deliberately NOT an error response -- "AI organization isn't
    // configured yet" is an expected, disclosed state that the client
    // renders as a plain notice, with manual save remaining fully
    // available.
    if (!env.ANTHROPIC_API_KEY) {
      logger.info("meeting_notes_organize_unavailable", { donorId, userId, provider });
      return Response.json({ available: false });
    }
    result = await organizeWithAnthropic({
      transcript,
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
    });
  } else {
    if (!env.AI) {
      logger.info("meeting_notes_organize_unavailable", { donorId, userId, provider });
      return Response.json({ available: false });
    }
    result = await organizeWithWorkersAI({
      transcript,
      ai: env.AI,
      model: env.WORKERS_AI_MODEL ?? DEFAULT_WORKERS_AI_MODEL,
    });
  }

  // Never log transcript content, the AI's response content, or any
  // credential -- only that an attempt happened, with which provider, and
  // whether it succeeded.
  logger.info("meeting_notes_organize_attempted", { donorId, userId, provider, ok: result.ok });
  if (!result.ok) return Response.json({ available: true, ok: false, error: result.error });
  return Response.json({ available: true, ok: true, data: result.data });
}
