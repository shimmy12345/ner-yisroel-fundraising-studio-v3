// Relationship Intelligence Phase 1 -- the explicit, hand-reviewed
// disposition map for the KNOWN 2026-08-21 legacy relationship_summary/
// institutional_memory corpus on Independent Staging (12 donors -- the
// entire non-null candidate set at review time). See docs/AI-HANDOFF.md's
// "Semantic Backfill Review" section for the full per-donor reasoning;
// the `reason` field below is a short pointer back to it, not a
// restatement.
//
// THIS IS NOT A GENERALIZABLE CLASSIFIER. It is a one-time, hand-
// reviewed allowlist for THIS specific historical migration -- never an
// autonomous system that infers disposition from text. A donor whose id
// does not appear in REVIEWED_HISTORICAL_DISPOSITIONS below is NOT
// automatically eligible for this migration, regardless of what the
// mechanical category/lifecycle classifier
// (lib/relationships/fact-classification.ts) would produce for their
// text -- this migration is scoped to the known, reviewed corpus, not a
// rolling future backfill mechanism. If the legacy corpus ever grows
// (e.g. a donor's relationship_summary is set through some path other
// than the normal, already-gated accept flows this app already has),
// that new donor requires its own explicit review and its own new entry
// here -- never automatic inclusion.

export const DISPOSITION = Object.freeze({
  BACKFILL: "BACKFILL_AS_RELATIONSHIP_FACT",
  STRUCTURED_DATA_COVERS_IT: "STRUCTURED_DATA_ALREADY_COVERS_IT",
  INTERACTION_HISTORY_ONLY: "INTERACTION_HISTORY_ONLY",
  NEEDS_REVIEW: "NEEDS_REVIEW",
});

// donorId -> { disposition, donorName, reason }. Every entry here was
// individually reviewed against the real, live-verified staging text and
// (where relevant) real asks/yahrtzeits rows -- not inferred from a
// pattern.
export const REVIEWED_HISTORICAL_DISPOSITIONS = Object.freeze({
  "e4626eea-56ce-4005-96db-eeafbfde6628": {
    disposition: DISPOSITION.INTERACTION_HISTORY_ONLY,
    donorName: "Dr. & Mrs. Yaakov Abdelhak",
    reason: "Pure outreach-action description (\"Personal invite to Teaneck event.\") -- no donor-specific fact survives independent of the action.",
  },
  "e34dc801-ab11-468e-b1bf-b6af52653262": {
    disposition: DISPOSITION.NEEDS_REVIEW,
    donorName: "Dr. & Mrs. Joel Danziger",
    reason: "Real donor fact (son's bar mitzvah) embedded inside fundraiser-action wording (\"Dropped off bottle of schnaps for...\"), not separable without inference.",
  },
  "bb929584-0ba8-4741-84b6-746427724bc4": {
    disposition: DISPOSITION.NEEDS_REVIEW,
    donorName: "Dr. & Mrs. Mark Danziger",
    reason: "Real, dated donor fact (grandson's bar mitzvah, this Shabbos) embedded inside a description of the fundraiser's phone call, not separable without inference.",
  },
  "cd4fbfd1-a461-4954-b580-64d3585f9cb9": {
    disposition: DISPOSITION.INTERACTION_HISTORY_ONLY,
    donorName: "Dr. & Mrs. Gavin Horn",
    reason: "Action-dominant (\"Messaged to welcome...\"); embedded fact (son at yeshiva) is generic, near-universal background, not distinguishing.",
  },
  "b5e8cc18-49f5-42c9-8511-26371ca3cef6": {
    disposition: DISPOSITION.STRUCTURED_DATA_COVERS_IT,
    donorName: "Mr. & Mrs. Mayer Simcha Klein",
    reason: "Real asks row already holds the amount/purpose ($5k, \"Plaque\", declined) -- verified live in D1.",
  },
  "d1b9cf78-2cdb-4546-9527-6210b95d16d4": {
    disposition: DISPOSITION.STRUCTURED_DATA_COVERS_IT,
    donorName: "Mr. & Mrs. Allen Pfeiffer",
    reason: "Real asks row already holds the amount ($10k, pending) -- verified live in D1.",
  },
  "952a1cc7-c05a-42ed-a472-463fdb1d633b": {
    disposition: DISPOSITION.STRUCTURED_DATA_COVERS_IT,
    donorName: "Rabbi Michoel A. Rovinsky",
    reason: "Real asks row's purpose field matches the legacy text verbatim (\"Plaque in memory of his wife\") -- verified live in D1.",
  },
  "5c35437c-4b08-4c05-8c65-bb3eb95e06aa": {
    disposition: DISPOSITION.STRUCTURED_DATA_COVERS_IT,
    donorName: "Dr. Jacques Semmelman",
    reason: "Real yahrtzeits row already holds the durable fact with a precise recurring date (Esther, Av 23) -- verified live in D1.",
  },
  "072ec28e-e73e-4981-a91d-5157aedad72d": {
    disposition: DISPOSITION.NEEDS_REVIEW,
    donorName: "Mr. & Mrs. Yaakov Sonnenblick",
    reason: "Same structure as Mark Danziger -- real, dated family fact embedded in fundraiser-action wording, not separable without inference.",
  },
  "9a9e3a1f-50d6-42b6-b986-c7608f0b8e8e": {
    disposition: DISPOSITION.NEEDS_REVIEW,
    donorName: "Mr. & Mrs. Dovie Weinschneider",
    reason: "Real donor fact (Kollel donation interest) embedded in a follow-up instruction; verified no asks row exists to cover it.",
  },
  "19af69d6-f147-474b-88ad-f6358ff65b9a": {
    disposition: DISPOSITION.BACKFILL,
    donorName: "Mr. & Mrs. Yaakov Zachter",
    reason: "The one evidenced, non-broadcast Zman-appreciation exception -- the extractor's own existing design already scopes the whole sentence correctly as one fact, no separable action/fact split needed.",
  },
  "2a1735d2-c3a6-4707-beb9-9ac7a0ab4e34": {
    disposition: DISPOSITION.INTERACTION_HISTORY_ONLY,
    donorName: "Mr. & Mrs. Tzvi Shlionsky",
    reason: "Action-dominant (\"Sent him an email with photo...\"); embedded fact (has a son) has no distinguishing stewardship value.",
  },
});

// Returns null (not one of the four dispositions) for any donor id not
// explicitly reviewed above -- callers must treat null the same as
// "not eligible", never assume eligibility by default.
export function getReviewedHistoricalDisposition(donorId) {
  return REVIEWED_HISTORICAL_DISPOSITIONS[donorId] ?? null;
}
