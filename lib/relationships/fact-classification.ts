import {
  COMMITMENT_PATTERN,
  RELATIONSHIP_CHANGE_PATTERN,
  ZMAN_APPRECIATION_PATTERN,
  SOLICITATION_FACT_PATTERN,
  HEALTH_FACT_PATTERN,
  FAMILY_MILESTONE_FACT_PATTERN,
  ENGAGEMENT_EVENT_FACT_PATTERN,
} from "../capture/interaction.ts";

// Relationship Intelligence Phase 1 -- see docs/AI-HANDOFF.md's
// "Relationship Snapshot Synthesis Design -- Lifecycle Correction".
// `category` (WHAT the fact is about, used only for supersession-
// matching) and `lifecycle` (HOW LONG it stays relevant) are
// deliberately separate concepts, assigned by two independent
// deterministic waterfalls below -- never conflated, never inferred from
// each other except as a documented, narrow default (see
// classifyFactLifecycle).
export type FactCategory = "family_milestone" | "solicitation" | "health" | "commitment_followup" | "engagement" | "general";
export type FactLifecycle = "durable" | "time_bound" | "follow_up";

// The two categories where "same category, same lifecycle" genuinely
// means "the same evolving state of one thing" (a donor has one live
// solicitation narrative and one current health status), so automatic
// supersession is safe there. Every other category is additive -- a
// donor can have many simultaneous, unrelated family/engagement/
// commitment facts, so same-category alone must never auto-supersede
// (this is the exact bug the Lifecycle Correction fixed: a bar-mitzvah
// fact and an unrelated later wedding fact must never collide just
// because both are family_milestone).
const SINGULAR_STATE_CATEGORIES: ReadonlySet<FactCategory> = new Set(["solicitation", "health"]);

export function isSingularStateCategory(category: FactCategory): boolean {
  return SINGULAR_STATE_CATEGORIES.has(category);
}

// An explicit relative- or calendar-time reference -- a month name, or
// "this/next/upcoming" + a season or a named Jewish holiday ("this
// Sukkos", "next spring"). A sentence anchored to a specific date is, by
// construction, going to become dated -- this is the primary time_bound
// signal, independent of category.
//
// "Shabbos" added 2026-08-21 during the Phase 1 backfill preview review:
// two real staging donors (Mark Danziger, Sonnenblick) have text reading
// "called to wish mazel tov on [grand]son's bar mitzvah this shabbos" --
// a genuinely near-term, dated event this pattern previously had no way
// to catch at all, so both defaulted to `durable` (family_milestone's
// conservative fallback) instead of `time_bound`. Deliberately just
// "Shabbos" -- the exact evidenced word, in the same "this/next/
// upcoming" + word position every other holiday name already uses -- not
// a broader day-of-week list (no other day name is observed in this
// corpus in this construction) and not a bare "after X" preposition
// (also not needed to fix any actual misclassification here: the one
// observed "after succos" instance, Weinschneider's, already resolves
// correctly via COMMITMENT_PATTERN regardless -- see docs/AI-HANDOFF.md
// for why that was investigated and deliberately not acted on).
export const RELATIVE_TIME_PATTERN = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\b(?:this|next|upcoming)\s+(?:week|month|year|spring|summer|fall|winter|Sukkos|Pesach|Chanukah|Purim|Rosh Hashanah|Yom Tov|Shabbos)\b/i;

// A NARROW subset of HEALTH_FACT_PATTERN's terms (lib/capture/
// interaction.ts) describing a transient STATE, not a permanent
// biographical fact. Deliberately excludes "passed away" -- a death is
// permanent, durable family context (see the worked example: "his
// mother passed away" is durable; the recurring anniversary date belongs
// in the separate, structured yahrtzeits table, never duplicated here).
// Kept as its own literal list rather than derived from HEALTH_TERMS by
// string subtraction, since the excluded term must be an explicit,
// visible decision, not an implicit side effect of set arithmetic.
export const TRANSIENT_HEALTH_STATE_PATTERN = /\b(?:sick|illness|recovering|hospital)\b/i;

// A death is permanent, durable family context -- never time_bound, never
// follow_up -- regardless of what other words share the sentence (e.g.
// "Promised to send flowers since his mother passed away" is still, at
// minimum, a durable biographical fact; in practice sentence-level
// extraction upstream already splits compound notes like this into
// separate specificFacts sentences before classification ever sees them,
// but this check is unconditional and checked FIRST specifically so
// permanence is never lost to a co-occurring commitment or date word).
// The recurring yahrtzeit date itself belongs in the separate, structured
// yahrtzeits table -- never duplicated here; this pattern only governs
// the free-text fact's own lifecycle.
export const PERMANENT_LIFE_EVENT_PATTERN = /\bpassed away\b/i;

// Category: WHAT the fact is about -- checked in a fixed priority order
// against the WHOLE input text (a single specificFacts sentence at
// accept time in Phase 2+, or, for Phase 1's backfill, a donor's entire
// pre-existing relationship_summary/institutional_memory value, which
// may already span more than one sentence). Priority order: a concrete
// commitment first (unambiguous), then the two singular-state categories
// (an ask-in-progress or a health update is usually the most salient
// thing in a mixed note), then family, then engagement (including
// zman-appreciation), else general. "general" also catches
// scholarship/student/tuition/education/seminary (program/beneficiary
// facts) and any specificFacts sentence not matching a genuinely
// evidenced signal below -- a safe, non-guessing fallback.
export function classifyFactCategory(text: string): FactCategory {
  if (COMMITMENT_PATTERN.test(text)) return "commitment_followup";
  if (SOLICITATION_FACT_PATTERN.test(text)) return "solicitation";
  if (HEALTH_FACT_PATTERN.test(text)) return "health";
  if (FAMILY_MILESTONE_FACT_PATTERN.test(text)) return "family_milestone";
  if (ENGAGEMENT_EVENT_FACT_PATTERN.test(text) || ZMAN_APPRECIATION_PATTERN.test(text)) return "engagement";
  return "general";
}

// Lifecycle: HOW LONG the fact stays relevant -- a 4-step deterministic
// waterfall, evaluated independently of category classification (though
// step 4's default is category-informed -- see below, this is the one
// deliberate, narrow place the two axes touch).
//
// 1. `durable`, unconditionally, if the text matches PERMANENT_LIFE_
//    EVENT_PATTERN ("passed away") -- checked FIRST, before even the
//    commitment check, since a death must never be misclassified as
//    time_bound (it shares the `health` category, which would otherwise
//    default to time_bound in step 4) or follow_up (even if a commitment
//    word happens to share the sentence).
// 2. `follow_up` if the text matches the EXISTING COMMITMENT_PATTERN
//    (lib/capture/interaction.ts already computes this exact sentence
//    set today as `commitments`, just not wired to lifecycle before this
//    module) -- an unambiguous, already-proven signal.
// 3. `time_bound` if the text contains an explicit relative/calendar-
//    time reference, OR a transient-state health verb (excluding "passed
//    away", handled by step 1), OR matches the EXISTING RELATIONSHIP_
//    CHANGE_PATTERN (state-change language is inherently a snapshot of a
//    moment).
// 4. Otherwise, the default depends on CATEGORY, not a single global
//    fallback: the two singular-state categories (`solicitation`,
//    `health`) default to `time_bound` -- an ask-in-progress or a health
//    status is inherently a point-in-time state even unphrased with an
//    explicit date ("he wants to think it over" has no date signal but
//    is still clearly not a standing identity fact). Every other
//    category defaults to `durable` ("His daughter is Danielle", "Very
//    close with Rabbi Cohen" -- neither has a date/health/change signal,
//    and neither category implies transience).
//
// Disclosed, not silently absorbed: a past, one-off event with no
// explicit date/relative-time word ("His grandson had his bar mitzvah")
// has no signal to catch it and defaults to `durable` via step 4 -- the
// deliberate, safer failure mode of a text-only deterministic system
// (stays visible longer than ideal, never silently vanishes). See
// docs/AI-HANDOFF.md for the full reasoning and the evidence-gated path
// to narrowing this later if real usage ever shows it matters.
export function classifyFactLifecycle(text: string, category: FactCategory): FactLifecycle {
  if (PERMANENT_LIFE_EVENT_PATTERN.test(text)) return "durable";
  if (COMMITMENT_PATTERN.test(text)) return "follow_up";
  if (RELATIVE_TIME_PATTERN.test(text) || TRANSIENT_HEALTH_STATE_PATTERN.test(text) || RELATIONSHIP_CHANGE_PATTERN.test(text)) return "time_bound";
  return isSingularStateCategory(category) ? "time_bound" : "durable";
}

export type FactClassification = { category: FactCategory; lifecycle: FactLifecycle };

// Convenience wrapper -- category must be computed first since lifecycle's
// step-3 default depends on it.
export function classifyRelationshipFact(text: string): FactClassification {
  const category = classifyFactCategory(text);
  const lifecycle = classifyFactLifecycle(text, category);
  return { category, lifecycle };
}

// Detects a real, narrow information-loss risk found in a real staging
// donor's text (Weinschneider: "Discussed Kollel donation and said to
// follow up after succos.") while investigating whether sentence-level
// lifecycle classification is sufficient. That sentence's COMMITMENT_
// PATTERN match ("follow up") wins classifyFactLifecycle's priority
// order, so the WHOLE sentence becomes `follow_up` -- which, per this
// module's own design, never enters relationship_summary/institutional_
// memory synthesis at all. But the same sentence ALSO matches
// SOLICITATION_FACT_PATTERN ("donation") -- a second, genuinely
// substantive, non-action fact ("he's discussing a Kollel donation")
// that would be silently and permanently lost from the synthesized
// Snapshot if the whole sentence is treated as pure follow_up.
//
// Deliberately NOT a general sentence-splitting or multi-fact-per-
// sentence redesign (out of scope -- "the smallest safe handling", not
// an NLP rework): this is a single boolean check, reusing the exact same
// patterns classifyFactCategory() already consults, that answers one
// narrow question -- "does this follow_up-classified text ALSO match a
// real substantive category signal that would be dropped?" -- so a
// caller (today: the backfill preview's safety checks; a natural,
// still-unbuilt future caller: Phase 2's accept flow) can flag the case
// for a human decision instead of silently discarding half the sentence.
// Only meaningful for text whose lifecycle is already `follow_up`;
// callers should gate on that first (calling this unconditionally is
// harmless -- COMMITMENT_PATTERN.test() is cheap and idempotent -- but
// pointless otherwise).
//
// Deliberately excludes `general` from the "substantive" check: general
// is the weak, no-real-signal fallback category itself, not evidence of
// a second real fact worth preserving.
export function hasSubstantiveContentBesidesCommitment(text: string): boolean {
  if (!COMMITMENT_PATTERN.test(text)) return false;
  return SOLICITATION_FACT_PATTERN.test(text) || HEALTH_FACT_PATTERN.test(text) || FAMILY_MILESTONE_FACT_PATTERN.test(text) || ENGAGEMENT_EVENT_FACT_PATTERN.test(text) || ZMAN_APPRECIATION_PATTERN.test(text);
}

// Per-category decay window in days, used ONLY for `time_bound` facts
// (recencyScore's exact existing linear formula from
// lib/relationships/recommendation-candidates.ts:
// `clamp01(1 - daysAgo / window)`, reused rather than reinvented).
// `durable` facts never consult this table (fixed baseline score, see
// DURABLE_BASELINE_SCORE). `follow_up` facts never consult it either --
// they never enter Snapshot synthesis scoring at all. commitment_
// followup's window is kept here only for documentation completeness/
// symmetry (a commitment_followup fact is always lifecycle `follow_up`
// in practice, since COMMITMENT_PATTERN is lifecycle's first, highest-
// priority check -- so this window is not expected to be consulted, but
// is defined rather than left undefined in case a future signal ever
// produces a commitment_followup category fact with a different
// lifecycle).
export const CATEGORY_DECAY_WINDOW_DAYS: Record<FactCategory, number> = {
  solicitation: 90,
  health: 180,
  engagement: 120,
  family_milestone: 180,
  general: 120,
  commitment_followup: 30,
};

// Fixed, non-time-decaying relevance score for `durable` facts -- a
// constant, reasoned not derived, matching this codebase's own
// established "not a claim worth making" convention for recencyScore's
// linear decay shape. Ranks below a genuinely fresh time_bound fact (a
// score approaching 1.0) for the terse relationship_summary cut, but
// above any time_bound fact that has decayed past its own window (score
// 0).
export const DURABLE_BASELINE_SCORE = 0.3;

// Minimum relevance score a fact must clear to appear in
// institutional_memory's fuller (but still capped) list. A durable
// fact's fixed 0.3 always clears this; a time_bound fact clears it only
// while still meaningfully within its category's decay window.
export const RELEVANCE_FLOOR = 0.1;
