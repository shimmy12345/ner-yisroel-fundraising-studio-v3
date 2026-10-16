// Ask Fundraising OS -- donor-reference resolution (docs/AI-HANDOFF.md,
// "Upgrade Ask Fundraising OS to a Real AI Assistant"). The bounded
// conversation-state types and pure bounding logic live in
// ./conversation-state.ts (re-exported below) specifically so they stay
// directly unit-testable; this file adds the one piece that genuinely
// needs the database -- turning a DonorReference into a real, currently-
// owned donor -- and so cannot be imported directly in a Node test
// process (see that file's own header comment).
//
// The one thing conversation state is allowed to influence is WHICH
// already-authorized donor a follow-up question like "tell me more about
// the second one" refers to -- never whether the request is authorized at
// all. A donor id carried in conversation state is re-verified against the
// CURRENT user's ownership on every single use below; conversation history
// can point at a donor, but it can never grant access to one the current
// request's own authenticated user doesn't own.

import { env } from "cloudflare:workers";
import { searchDonors, type AssistantContext, type DonorRef } from "./capabilities.ts";
import { boundConversationState, donorHref, type ConversationState, type ConversationTurn, type DonorReference, MAX_HISTORY_TURNS, MAX_HISTORY_CHARS, MAX_QUESTION_LENGTH } from "./conversation-state.ts";

export { boundConversationState, donorHref, MAX_HISTORY_TURNS, MAX_HISTORY_CHARS, MAX_QUESTION_LENGTH };
export type { ConversationState, ConversationTurn, DonorReference, DonorRef };

export type DonorResolution =
  | { kind: "resolved"; donor: DonorRef }
  | { kind: "ambiguous"; candidates: DonorRef[] }
  | { kind: "not_found" }
  | { kind: "none" };

// Resolves a planner-produced DonorReference into a real, currently-owned
// donor -- the ONLY path from a conversational reference to a donor id.
// An ordinal ("the second one") indexes into the conversation's own
// lastDonorRefs, but the id it names is always re-checked against this
// request's authenticated userId before being trusted (see the ownership
// query below) -- conversation state is client-round-tripped, so it is
// never assumed to still belong to this user, only verified fresh. A name
// reference is resolved via the same bounded, owner-scoped searchDonors
// capability a fundraiser's own "find a donor" question would use --
// never by asking the model to produce or guess an id itself. Multiple
// matches are reported back as candidates, never guessed between.
export async function resolveDonorReference(reference: DonorReference, state: ConversationState, ctx: AssistantContext): Promise<DonorResolution> {
  if (reference.kind === "none") return { kind: "none" };

  if (reference.kind === "ordinal") {
    const candidate = state.lastDonorRefs[reference.value - 1];
    if (!candidate) return { kind: "not_found" };
    if (ctx.mode !== "live") return { kind: "not_found" };
    const owned = await env.DB.prepare("SELECT id, display_name FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL").bind(candidate.donorId, ctx.userId).first<{ id: string; display_name: string }>();
    if (!owned) return { kind: "not_found" };
    // Never trust candidate.href, even though it was client-supplied
    // conversation state -- the canonical link is always rebuilt here
    // from the just-verified, owned donor id. This is deliberate
    // defense in depth on top of boundConversationState's own
    // regeneration (conversation-state.ts): this function's own
    // guarantee -- "never return a donor without having verified
    // ownership first" -- must hold even if that upstream step is ever
    // changed (independent code review, donor profile URL security,
    // 2026-10-16).
    return { kind: "resolved", donor: { donorId: owned.id, name: owned.display_name, href: donorHref(owned.id) } };
  }

  // name
  const matches = await searchDonors(ctx, reference.value);
  if (matches.length === 0) return { kind: "not_found" };
  if (matches.length === 1) return { kind: "resolved", donor: matches[0] };
  // Prefer an exact (case-insensitive) name match among multiple partial
  // matches rather than asking the fundraiser to disambiguate something
  // that is actually unambiguous.
  const exact = matches.find((m) => m.name.toLowerCase() === reference.value.trim().toLowerCase());
  if (exact) return { kind: "resolved", donor: exact };
  return { kind: "ambiguous", candidates: matches };
}
