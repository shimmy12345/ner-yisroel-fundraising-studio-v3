import { addCalendarDays, localDateParts, zonedTimeToUtc } from "../workspace/local-time.ts";

export type InteractionKind = "call" | "email" | "meeting" | "visit" | "note" | "personal" | "text";
export type ReminderChoice = "none" | "tomorrow" | "next-week" | "custom";

export type InteractionExtraction = {
  type: InteractionKind;
  subject: string;
  suggestedSubject: string;
  summary: string;
  memory: string;
  // null when nothing specific/donor-relevant was actually extracted from
  // this note -- see actionableRelationshipSnapshot's doc comment. Never a
  // manufactured placeholder; callers must treat null as "nothing to show
  // or save here", not coerce it to an empty string.
  relationshipSummary: string | null;
  nextAction: string;
  commitments: string[];
};

const KIND_LABELS: Record<InteractionKind, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  visit: "Visit",
  note: "Note",
  personal: "Personal interaction",
  text: "Text Message",
};

export function interactionKindLabel(kind: InteractionKind): string {
  return KIND_LABELS[kind];
}

export function inferInteractionKind(note: string): InteractionKind {
  const lower = note.toLowerCase();
  if (/\b(called|phone|spoke by phone|voicemail)\b/.test(lower)) return "call";
  if (/\b(texted|text message|texting|sms|whatsapp|imessage)\b/.test(lower)) return "text";
  if (/\b(emailed|email|wrote to|replied)\b/.test(lower)) return "email";
  if (/\b(coffee|lunch|dinner|met|meeting)\b/.test(lower)) return "meeting";
  if (/\b(visit|visited|campus tour|stopped by)\b/.test(lower)) return "visit";
  if (/\b(birthday|anniversary|family|personal)\b/.test(lower)) return "personal";
  return "note";
}

export function inferSubject(note: string, kind: InteractionKind): string {
  const signals: Array<[RegExp, string]> = [
    [/\b(pledge|pledged|pledge balance|installment|payment)\b/i, "Pledge payment"],
    [/\b(gift|giving|donation|contribution)\b/i, "Giving follow-up"],
    [/\b(scholarship|student|tuition|education)\b/i, "Scholarship update"],
    [/\b(outcome|outcomes|impact|result|results|progress report|annual report)\b/i, "Impact update"],
    [/\b(campus|tour|school visit|site visit)\b/i, "Campus visit"],
    [/\b(proposal|request for support|funding request|ask amount)\b/i, "Proposal follow-up"],
    [/\b(event|gala|dinner|reception|parlor meeting)\b/i, "Event planning"],
    [/\b(family|spouse|son|daughter|birthday|anniversary)\b/i, "Personal update"],
  ];
  const matches = signals
    .map(([pattern, label]) => ({ label, index: note.search(pattern) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.label === item.label) === index)
    .slice(0, 2)
    .map((item) => item.label);
  if (matches.length === 2) return `${matches[0]} and ${matches[1].toLowerCase()}`;
  if (matches.length === 1) return matches[0];
  const fallbacks: Record<InteractionKind, string> = {
    call: "Donor call follow-up",
    email: "Donor email follow-up",
    meeting: "Donor meeting follow-up",
    visit: "Donor visit follow-up",
    note: "Relationship update",
    personal: "Personal update",
    text: "Text message follow-up",
  };
  return fallbacks[kind];
}

const sentenceList = (note: string) => note.trim().split(/(?:[.!?]+\s+|[\r\n]+)/).map((item) => item.trim()).filter(Boolean);
const concise = (value: string, max = 180) => value.length <= max ? value : `${value.slice(0, max - 1).trim()}…`;

// Proven false positive (staging incidents): notes reading "Solicited for a
// plaque ($5k)" and "Messaged about the building fund" -- genuine,
// correctly-captured notes whose first word is a common fundraising/
// communication verb, not a person -- were extracted as "People mentioned:
// Solicited"/"People mentioned: Messaged." This regex has no way to tell
// "capitalized because it's a proper noun" from "capitalized only because
// it opens a sentence", so every common way a fundraiser's note plausibly
// opens (a channel verb, a CRM disposition verb) is excluded by name here.
// This list is intentionally bounded to this specific, closed domain
// vocabulary -- how a fundraiser describes contacting or dispositioning a
// donor -- not an open-ended attempt at general English verb detection.
const COMMUNICATION_ACTION_VERBS = [
  "Called", "Emailed", "Messaged", "Texted", "Spoke", "Met", "Discussed", "Asked", "Visited", "Contacted", "Reached", "Sent", "Shared", "Followed", "Send", "Follow",
  "Solicited", "Declined", "Confirmed", "Pending", "Requested", "Reviewed", "Completed", "Cancelled", "Rescheduled", "Postponed", "Attended", "Scheduled", "Reminded", "Thanked", "Updated", "Approved", "Rejected", "Received", "Processed",
  // "Dropped" added 2026-08-21: a real donor note ("Dropped off bottle of
  // schnaps for son's bar mitzvah") was misread as mentioning a person
  // named "Dropped" -- the same class of sentence-initial disposition/
  // action verb the rest of this list already covers, just missing.
  "Dropped",
];
// Three genuine closed grammatical categories, not fundraising-specific
// jargon -- modal auxiliary verbs ("Will send...", "Would follow up..."),
// days of the week ("...by Friday"), and indefinite pronouns ("Nothing
// major") are all common sentence-initial or mid-sentence capitalized
// words in a short note, and none of them is ever a donor's name.
const MODAL_VERBS = ["Will", "Would", "Should", "Could", "Can", "May", "Might", "Must", "Shall"];
const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const INDEFINITE_PRONOUNS = ["Nothing", "Everything", "Something", "Anything"];
// Closed, evidenced (not speculative) categories added 2026-08-21 during
// the people-extraction false-positive investigation -- see
// docs/AI-HANDOFF.md for the full corpus audit. Each entry below was
// proven, not guessed: it actually appeared, capitalized, as a false
// "person" in a real interaction note on Independent Staging.
//
// Jewish-calendar/communal terms: "Zman" (Yeshiva semester/term --
// donor 60830/Zachter: "...first day of Zman and thanked him..."),
// "Yahrtzeit" (death anniversary -- donor 72957/Semmelman: "...wife's
// Yahrtzeit to acknowledge it"), "Kollel" (full-time Torah-study
// fellowship -- donor 68390/Weinschneider: "Discussed Kollel donation
// and said to follow up after succos"). The task's own broader candidate
// list (Shabbos, Yom Tov, Purim, Pesach, Sukkos, Chanukah, Rosh
// Hashanah, Torah, Beis Medrash, Mechina, Campaign) was explicitly
// audited against the real corpus and NONE of them actually appeared as
// a false-positive person -- not added, per the same evidence-only
// standard. "Dinner" was already covered below before this task.
const JEWISH_CALENDAR_AND_COMMUNAL_TERMS = ["Zman", "Yahrtzeit", "Kollel"];
// Machine-generated import-provenance boilerplate, not donor-relevant
// text at all: every Monday.com-imported interaction's summary has
// "Imported from Monday.com pipeline export. Source due date: ..."
// appended (see app/api/import/monday/commit/route.ts), and both
// capitalized sentence-initial words in that fixed template were
// misread as people on all 5 real imported interactions on Independent
// Staging.
const IMPORT_PROVENANCE_WORDS = ["Imported", "Source"];
const NON_NAME_WORDS = new Set(["Meeting", "Coffee", "Lunch", "Dinner", "The", "This", "That", "These", "Those", "She", "He", "They", "We", "I", "It", ...COMMUNICATION_ACTION_VERBS, ...MODAL_VERBS, ...DAYS_OF_WEEK, ...INDEFINITE_PRONOUNS, ...JEWISH_CALENDAR_AND_COMMUNAL_TERMS, ...IMPORT_PROVENANCE_WORDS]);

// Generalizes beyond the fixed verb list above: a bare capitalized word
// immediately followed by one of these words is being used as a verb, not
// standing alone as someone's name -- "Messaged about", "Reconnected with",
// "Chatted via" -- a real first name essentially never precedes these
// particles at the start of a sentence in this note-writing style ("David
// about the pledge" is not how these notes read). Catches a future
// unlisted verb without needing the dictionary to be exhaustive.
//
// Deliberately restricted to a match at the very start of the note (see
// the sentence-boundary check at its call site) -- as documented above,
// this was only ever meant to catch a SENTENCE-INITIAL verb. Applied
// unconditionally, it also caught real names in the object position of a
// normal sentence: "Spoke with Yaakov about the new Zman" incorrectly
// dropped "Yaakov" too, since "Yaakov" happens to be followed by "about"
// -- even though "Yaakov" is clearly a person being discussed, not a
// disposition verb. A verb-follower reading only makes sense when there
// is no subject before it.
const VERB_FOLLOWER_PATTERN = /^(about|regarding|with|via)\b/i;

// Regular plurals matter here: real notes as often say "Yeshivas Ner
// Yisroel" (institution word FIRST, qualifier after -- the common pattern
// for yeshiva names) as "Ford Foundation" (qualifier first). A literal
// "Yeshiva" with no "s" handling matched neither the plural nor a
// keyword-first name, letting a real organization slip through
// unrecognized and get misclassified as a person instead.
const ORG_TYPE_WORD = "Foundations?|Universit(?:y|ies)|Colleges?|Schools?|Yeshivas?|Synagogues?|Congregations?|Hospitals?|Compan(?:y|ies)|Inc\\.?|LLC";
const ORG_TYPE_TEST = new RegExp(`\\b(?:${ORG_TYPE_WORD})\\b`, "u");

function mentionedPeople(note: string) {
  const matches = [...note.matchAll(/\b\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*/gu)];
  const names = matches
    .map((match) => {
      // A leading word already known to never be a name (a disposition
      // verb, modal, day, pronoun...) doesn't make the WHOLE multi-word
      // span a name either -- "Discussed Kollel donation..." is
      // "Discussed" (excluded) + "Kollel" (a real word, evaluated on its
      // own), not a two-word person name; "Met Rabbi Cohen" is "Met"
      // (excluded) + "Rabbi Cohen" (a genuine name, kept intact). Proven
      // by a real note (Weinschneider, 68390) where this previously
      // produced "Discussed Kollel" as a fabricated person. Only LEADING
      // words are stripped -- a genuine two-word name ("David Cohen") has
      // no excluded word to strip and passes through completely
      // unchanged.
      let words = match[0].trim().split(/\s+/);
      while (words.length > 1 && NON_NAME_WORDS.has(words[0])) words = words.slice(1);
      const name = words.join(" ").replace(/[’']s$/u, "");
      if (!name) return null;
      if (NON_NAME_WORDS.has(name)) return null;
      if (ORG_TYPE_TEST.test(name)) return null;
      // Only single-word matches are structurally ambiguous with a verb --
      // a genuine multi-word match ("David Cohen") is never mistaken for a
      // sentence-initial verb, so this check only ever narrows single words.
      // Uses this specific match's own position (not indexOf) so a repeated
      // word elsewhere in the note can't be checked against the wrong
      // occurrence's context. Further restricted to a SENTENCE-initial
      // match (start of the note, or immediately after a
      // ./!/?/newline) -- matching VERB_FOLLOWER_PATTERN's own stated
      // intent ("a real first name essentially never precedes these
      // particles AT THE START OF A SENTENCE"), which the code
      // previously didn't actually enforce. Without this, "Spoke with
      // Yaakov about the new Zman" incorrectly dropped "Yaakov" too,
      // since "about" happens to follow it mid-sentence -- a real name
      // in the object position of "with", not a disposition verb.
      if (!name.includes(" ")) {
        const beforeIndex = match.index ?? 0;
        const sentenceInitial = beforeIndex === 0 || /[.!?\r\n]\s*$/.test(note.slice(0, beforeIndex));
        if (sentenceInitial) {
          const afterIndex = beforeIndex + match[0].length;
          const after = note.slice(afterIndex).replace(/^[.,!?]?\s*/, "");
          if (VERB_FOLLOWER_PATTERN.test(after)) return null;
        }
      }
      return name;
    })
    .filter((name): name is string => name !== null);
  return [...new Set(names)].slice(0, 5);
}

function mentionedOrganizations(note: string) {
  const organizations = [
    // Qualifier-first pattern ("Ford Foundation", "Beth Israel Hospital").
    ...(note.match(new RegExp(`\\b(?:\\p{Lu}[\\p{L}'’&.-]*\\s+){0,5}(?:${ORG_TYPE_WORD})\\b`, "gu")) ?? []),
    // Keyword-first pattern ("Yeshivas Ner Yisroel") -- the common naming
    // convention for yeshivas specifically, which the qualifier-first
    // pattern above structurally can't capture at all.
    ...(note.match(/\bYeshivas?\s+(?:\p{Lu}[\p{L}'’-]*\s*){1,4}/gu) ?? []),
  ];
  // A bare institution-type word with no qualifier ("Yeshiva", "School",
  // "Foundation" alone) doesn't identify any SPECIFIC organization -- it's
  // a generic category, not a donor-relevant fact. Only keep matches with
  // a real qualifying word attached ("Yeshivas Ner Yisroel", "Beth Israel
  // Congregation").
  return [...new Set(organizations.map((item) => item.trim()).filter((item) => item.includes(" ")))].slice(0, 5);
}

function commitmentAction(sentence: string) {
  const match = sentence.match(/\b(?:promised|agreed|committed|will|would)\s+(?:to\s+)?(.+)/i);
  if (match?.[1]) return concise(match[1].replace(/[.!?]+$/, ""), 120);
  const direct = sentence.match(/\b(send|follow up|call back|introduce|schedule|share|provide)\b(.+)/i);
  return direct ? concise(`${direct[1]}${direct[2]}`.replace(/[.!?]+$/, ""), 120) : null;
}

// Exported (not just used internally) for reuse by
// lib/relationships/fact-classification.ts's lifecycle waterfall --
// Relationship Intelligence Phase 1, see docs/AI-HANDOFF.md. Reused
// verbatim, never reimplemented, matching this codebase's own established
// convention for every other feature that builds on this extractor.
export const COMMITMENT_PATTERN = /\b(promised|agreed|committed|will|would|send|follow up|follow-up|call back|introduce|schedule|share|provide)\b/i;
export const RELATIONSHIP_CHANGE_PATTERN = /\b(increased|decreased|changed|newly|no longer|ready|hesitant|more involved|less involved|reconnected|stepped back)\b/i;
// The same closed vocabulary inferSubject() already uses to classify a
// note into a coarse category (pledge/gift/scholarship/campus/proposal/
// event/personal) -- reused here not to produce another label, but to
// find the actual SENTENCE that earned the classification, so the
// specific fact survives instead of being collapsed into a generic
// category name. A sentence flagged here is a real quote from the note,
// never a manufactured phrase.
// grandson/granddaughter/grandchild/grandparent/grandmother/grandfather
// added 2026-08-20: \bson\b never matched inside "grandson" (no word
// boundary before "son" when preceded by "grand"), so a note about a
// donor's grandchild's milestone -- common phrasing for this fundraiser --
// silently produced no relationship-snapshot facts. Proven via a real
// donor pair (987 vs 67909, near-identical notes differing only in
// "grandson's" vs "son's"); see docs/AI-HANDOFF.md.
// yahrtzeit/yahrtzeits added 2026-08-20: a death anniversary of a family
// member (like birthday/anniversary above) is exactly the class of
// durable personal fact this pattern exists to catch. Proven via a real
// donor (Semmelman, 72957) whose note -- "Sent text on wife's Yahrtzeit
// to acknowledge it" -- produced no fact because this word was missing.
// A corpus-wide read-only audit found no alternate spelling
// (yahrzeit/yartzeit/yortzeit) anywhere in real data, so none is added
// speculatively; see docs/AI-HANDOFF.md.
// Broken into named, exported term groups (Relationship Intelligence
// Phase 1, see docs/AI-HANDOFF.md) so lib/relationships/fact-
// classification.ts can determine WHICH cluster matched -- FACT_SIGNAL_
// PATTERN itself only ever answers "does something specific match",
// never which -- for category assignment, without re-deriving or
// duplicating this list. Recomposed below into the exact same combined
// pattern as before this refactor (verified byte-identical term set,
// same test suite green) -- this is a structural split, not a behavior
// change. "Engagement" naming note: ENGAGEMENT_EVENT_TERMS means donor
// engagement/visit/event activity (campus tour, gala); the unrelated
// "engaged"/"engagement" (marriage) words live in FAMILY_MILESTONE_TERMS.
// "solicited" added 2026-08-21 during the Relationship Intelligence
// Phase 1 backfill preview review: three real staging donors (Klein,
// Pfeiffer, Rovinsky) have relationship-intelligence text reading
// "Solicited for a plaque ($5k)" / "Solicited for $10k" / "Solicited for
// a plaque in memory of his wife ($5k)" -- genuine solicitation language
// this pattern previously had no term for at all (COMMUNICATION_ACTION_
// VERBS' "Solicited" entry is a completely separate system -- it only
// excludes the word from PEOPLE-mentioned matching, never from fact-
// signal detection). Without this, these three donors' text produced no
// fact-signal match under FACT_SIGNAL_PATTERN at all. Deliberately just
// "solicited" -- the exact evidenced word -- not also "solicitation" or
// bare "solicit", which are not observed anywhere in the real corpus;
// see docs/AI-HANDOFF.md for the full evidence.
export const SOLICITATION_FACT_TERMS = "pledge|pledged|pledge balance|installment|payment|gift|giving|donation|contribution|proposal|request for support|funding request|ask amount|solicited";
export const PROGRAM_BENEFICIARY_TERMS = "scholarship|student|tuition|education|seminary";
export const ENGAGEMENT_EVENT_TERMS = "campus|tour|school visit|site visit|event|gala|dinner|reception|parlor meeting";
export const FAMILY_MILESTONE_TERMS = "family|spouse|son|daughter|grandsons?|granddaughters?|grandchild(?:ren)?|grandparents?|grandmothers?|grandfathers?|wedding|engaged|engagement|birthday|anniversary|yahrtzeits?";
export const HEALTH_TERMS = "sick|illness|recovering|hospital|passed away";
export const SOLICITATION_FACT_PATTERN = new RegExp(`\\b(?:${SOLICITATION_FACT_TERMS})\\b`, "i");
export const PROGRAM_BENEFICIARY_FACT_PATTERN = new RegExp(`\\b(?:${PROGRAM_BENEFICIARY_TERMS})\\b`, "i");
export const ENGAGEMENT_EVENT_FACT_PATTERN = new RegExp(`\\b(?:${ENGAGEMENT_EVENT_TERMS})\\b`, "i");
export const FAMILY_MILESTONE_FACT_PATTERN = new RegExp(`\\b(?:${FAMILY_MILESTONE_TERMS})\\b`, "i");
export const HEALTH_FACT_PATTERN = new RegExp(`\\b(?:${HEALTH_TERMS})\\b`, "i");
const FACT_SIGNAL_PATTERN = new RegExp(`\\b(?:${SOLICITATION_FACT_TERMS}|${PROGRAM_BENEFICIARY_TERMS}|${ENGAGEMENT_EVENT_TERMS}|${FAMILY_MILESTONE_TERMS}|${HEALTH_TERMS})\\b`, "i");

// Deliberately NOT a bare `\bzman\b` addition to FACT_SIGNAL_PATTERN above
// -- a read-only corpus audit (2026-08-20) found "zman" in 39 of 42 real
// interaction notes, and all but one of those are identical mass-broadcast
// templates sent to dozens of donors ("Sent time lapse video from first
// name of the zman", "...welcome son (or grandson) back for the new
// zman"), not donor-specific facts. "Zman" (the Yeshiva semester/term) is
// only a meaningful STEWARDSHIP fact when the note explicitly ties it to
// this donor's own support -- e.g. "Texted video from first day of Zman
// and thanked him for his support that makes it happen" (the one real
// exception, donor 60830). The same audit found "thank"/"support" each
// occur in exactly that one note, and nowhere else, in the whole corpus.
// Given how rare both words already are on their own, requiring a
// zman/semester mention AND (a thank-word OR "support") together in one
// sentence is a conservative rule backed directly by that evidence, not a
// speculative phrase-engineering exercise from a single example: every
// real broadcast "zman" sentence lacks both words and is correctly
// excluded, and a bare "Thanked him" with no zman/semester mention is
// also correctly excluded (thanks alone was never the signal). See
// docs/AI-HANDOFF.md for the full corpus evidence and false-positive
// design.
// Exported for reuse by lib/relationships/fact-classification.ts's
// category waterfall (folded into "engagement" -- see that file).
export const ZMAN_APPRECIATION_PATTERN = /(?=.*\bzman\b)(?=.*\b(?:thanks?|thanked|thanking|support)\b)/i;

export type RelationshipSnapshotDetails = {
  people: string[];
  organizations: string[];
  commitments: string[];
  openFollowUps: string[];
  relationshipChanges: string[];
  // null when no commitment sentence yielded a concrete, gradable action --
  // never a manufactured "review this note" placeholder. See
  // actionableRelationshipSnapshot's doc comment for why this must stay
  // null rather than fall back to boilerplate.
  recommendedNextAction: string | null;
  // Real, quoted sentences worth surfacing as relationship intelligence --
  // specific donor-relevant facts, never a generic category label
  // ("Personal update", "Relationship update"). Prioritized: a concrete
  // commitment first, then a noted relationship change, then any other
  // sentence matching a recognized fact signal. Deduplicated and capped at
  // 2 -- a snapshot is meant to be a quick prompt before the next
  // interaction, not a full transcript.
  specificFacts: string[];
};

// `kind` is unused here now (topics/category labels were dropped from this
// output -- see specificFacts below) but stays in the signature since
// every caller already has it on hand and passes it, matching
// inferSubject's shape (still used separately for subject-line suggestions).
export function relationshipSnapshotDetails(note: string, kind: InteractionKind): RelationshipSnapshotDetails {
  const sentences = sentenceList(note);
  const people = mentionedPeople(note);
  const organizations = mentionedOrganizations(note);
  const commitmentSentences = sentences.filter((sentence) => COMMITMENT_PATTERN.test(sentence)).slice(0, 3);
  const relationshipChangeSentences = sentences.filter((sentence) => RELATIONSHIP_CHANGE_PATTERN.test(sentence)).slice(0, 2);
  const factSignalSentences = sentences.filter((sentence) => FACT_SIGNAL_PATTERN.test(sentence));
  const zmanAppreciationSentences = sentences.filter((sentence) => ZMAN_APPRECIATION_PATTERN.test(sentence));
  const nextAction = commitmentSentences.map(commitmentAction).find(Boolean) ?? null;
  const cleanSentence = (sentence: string) => concise(sentence).replace(/[.!?]+$/, "");
  const specificFacts = [...new Set([...commitmentSentences, ...relationshipChangeSentences, ...factSignalSentences, ...zmanAppreciationSentences].map(cleanSentence))].slice(0, 2);
  return {
    people,
    organizations,
    commitments: commitmentSentences.map(cleanSentence),
    openFollowUps: nextAction ? [nextAction] : [],
    relationshipChanges: relationshipChangeSentences.map(cleanSentence),
    recommendedNextAction: nextAction,
    specificFacts,
  };
}

// Builds donors.relationship_summary. Returns null -- never a placeholder
// string -- when nothing specific and donor-relevant was actually found in
// the note: a generic category label ("Personal update", "Yeshiva" alone)
// or the mere fact that an interaction happened is not relationship
// intelligence worth persisting or displaying. Every caller (the capture
// preview, the donor page's Relationship Snapshot card, Meeting Brief,
// Assistant) must treat null as "nothing to show", not coerce it to text.
// When something IS worth keeping, this returns a plain natural-language
// sentence (or two) quoted from the note itself -- never a dump of field
// labels like "Latest discussion topics: ...\nPeople mentioned: ...".
export function actionableRelationshipSnapshot(note: string, kind: InteractionKind): string | null {
  const details = relationshipSnapshotDetails(note, kind);
  if (details.specificFacts.length === 0) return null;
  return details.specificFacts.map((fact) => /[.!?]$/.test(fact) ? fact : `${fact}.`).join(" ");
}

export function sanitizeRelationshipSnapshot(value: string | null) {
  if (!value) return value;
  const cleaned = value
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .map((item) => item.trim())
    .filter((item) => item && !/\b(?:AI confidence|sentiment|classification|extraction status|positive or negative sentiment was inferred)\b/i.test(item))
    .join(" ");
  return cleaned || null;
}

export function splitInteractionSummary(summary: string) {
  const [subject = "", ...noteParts] = summary.split("\n");
  const note = noteParts.join("\n");
  const firstLine = note.split(/[\r\n]/, 1)[0]?.trim() ?? "";
  return { subject, note, timelineTitle: subject.trim() || "Interaction Note", timelineNote: (subject.trim() ? note.trim() : firstLine) || "No additional notes recorded." };
}

// "tomorrow"/"next-week" are relative to the user's own local calendar day
// (in `timezone`, not the Cloudflare Worker's UTC runtime clock), and
// every reminder lands at 9:00 AM local wall-clock time on its target day
// -- never 9:00 AM UTC. `timezone` defaults to "America/New_York" (this
// workspace's expected default, matching lib/auth/profile.ts) only when a
// caller genuinely has no stored profile timezone to pass; ordinary
// callers should always pass profile.timezone.
export function reminderDueAt(choice: ReminderChoice, customDate: string | undefined, now: Date, timezone = "America/New_York"): Date | null {
  if (choice === "none") return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (choice === "tomorrow") {
    const target = addCalendarDays(localDateParts(nowSeconds, timezone), 1);
    return zonedTimeToUtc(target.year, target.month, target.day, 9, 0, timezone);
  }
  if (choice === "next-week") {
    const target = addCalendarDays(localDateParts(nowSeconds, timezone), 7);
    return zonedTimeToUtc(target.year, target.month, target.day, 9, 0, timezone);
  }
  if (choice === "custom") {
    if (!customDate || !/^\d{4}-\d{2}-\d{2}$/.test(customDate)) return null;
    const [year, month, day] = customDate.split("-").map(Number);
    return zonedTimeToUtc(year, month, day, 9, 0, timezone);
  }
  return null;
}

export function extractInteraction(note: string, requestedKind?: InteractionKind, requestedSubject?: string): InteractionExtraction {
  const type = requestedKind ?? inferInteractionKind(note);
  const subject = requestedSubject?.trim() ?? "";
  const suggestedSubject = inferSubject(note, type);
  const lower = note.toLowerCase();
  const actionContext = subject || suggestedSubject;
  const commitments = [
    ...(lower.includes("send") ? [`Send the material referenced in “${actionContext}”`] : []),
    ...(/follow up|follow-up/.test(lower) ? [`Follow up on “${actionContext}”`] : []),
  ];
  return {
    type,
    subject,
    suggestedSubject,
    summary: note.trim(),
    memory: `${interactionKindLabel(type)} context: ${note.trim()}`,
    relationshipSummary: actionableRelationshipSnapshot(note, type),
    nextAction: commitments[0] ?? `Review the ${interactionKindLabel(type).toLowerCase()} note before the next interaction.`,
    commitments,
  };
}
