import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mondayHistoricalContextId, mondayInteractionId, mondayRecommendationId, mondaySourceFingerprint } from "../lib/import/monday-fingerprint.ts";

// Same convention as tests/monday-import-safety.test.mjs: donor_historical_context
// is written through a route that only exists inside a Cloudflare Workers
// runtime (env.DB), so its D1-dependent safety properties are verified
// against the route/UI/schema source text rather than by executing it
// against a live D1 instance. The deterministic id derivation itself IS a
// pure function and is exercised directly below.

async function run() {
  const commit = await readFile(new URL("../app/api/import/monday/commit/route.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../app/settings/monday-import/MondayImportExperience.tsx", import.meta.url), "utf8");
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  const relationshipRead = await readFile(new URL("../lib/relationships/read.ts", import.meta.url), "utf8");
  const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0024_donor_historical_context.sql", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

  // --- 1 & 10: idempotency / no duplicate on re-import -- pure, executed ---
  const input = { donorCode: "M001", subitemIndex: 2, text: "Ask him to join the Sarei Alafim", dueDateRaw: null };
  const fingerprintA = mondaySourceFingerprint(input);
  const fingerprintB = mondaySourceFingerprint({ ...input });
  assert.equal(fingerprintA, fingerprintB, "identical Monday-side input must always produce the identical fingerprint");
  assert.equal(mondayHistoricalContextId(fingerprintA), mondayHistoricalContextId(fingerprintB), "re-importing the same row must resolve to the same historical-context id");
  assert.equal(mondayHistoricalContextId(fingerprintA), `monday-context-${fingerprintA}`);
  assert.doesNotMatch(mondayHistoricalContextId(fingerprintA), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must not collide with crypto.randomUUID()'s output space");
  // Disjoint from the interaction/recommendation id spaces for the exact same fingerprint.
  assert.notEqual(mondayHistoricalContextId(fingerprintA), mondayInteractionId(fingerprintA));
  assert.notEqual(mondayHistoricalContextId(fingerprintA), mondayRecommendationId(fingerprintA));

  // --- commit route: idempotent upsert on the deterministic id ---
  assert.match(commit, /SELECT id FROM donor_historical_context WHERE id=\? AND user_id=\?/);
  assert.match(commit, /UPDATE donor_historical_context SET/);
  assert.match(commit, /INSERT INTO donor_historical_context/);
  assert.match(commit, /mondayHistoricalContextId\(fingerprint\)/);

  // --- 7, 8, 9: disposition gating for save_historical_context ---
  const allowListMatch = /HISTORICAL_CONTEXT_ALLOWED_DISPOSITIONS = new Set\(\[([^\]]+)\]\)/.exec(commit);
  assert.ok(allowListMatch, "the allow-list constant must exist and be readable");
  const allowList = allowListMatch[1];
  assert.match(allowList, /"confirm_contact_candidate"/, "a likely-completed-contact row must be saveable as historical context");
  assert.match(allowList, /"historical_planned"/, "a past-dated/undated historical row must be saveable as historical context");
  assert.match(allowList, /"ambiguous"/, "an ambiguous row must be saveable as historical context");
  assert.doesNotMatch(allowList, /"donation_note"/, "a donation note must never be saveable as historical context");
  assert.doesNotMatch(allowList, /"future_planned"/, "a future planned action must never be saveable as historical context");
  // A likely-completed row can go either to a real interaction (confirm_contact)
  // or to historical context -- both branches independently accept the same disposition.
  assert.match(commit, /if \(disposition !== "confirm_contact_candidate"\) \{ rejected\.push\(\{ text, reason: "This row is not a likely completed contact" \}\); continue; \}/);

  // --- 4 & 5: the save_historical_context branch never writes interactions
  // or recommendations, and the confirm/create-followup branches never
  // write donor_historical_context -- isolate each action's own code block
  // and check it only touches its own table. ---
  const branchStart = commit.indexOf('decision.action === "save_historical_context"');
  assert.ok(branchStart > -1, "the save_historical_context branch must exist");
  const branchEnd = commit.indexOf('rejected.push({ text, reason: "Unsupported action" });', branchStart);
  const historicalContextBranch = commit.slice(branchStart, branchEnd);
  assert.doesNotMatch(historicalContextBranch, /INSERT INTO interactions|UPDATE interactions/, "save_historical_context must never write a completed interaction");
  assert.doesNotMatch(historicalContextBranch, /INSERT INTO recommendations|UPDATE recommendations/, "save_historical_context must never create an open recommendation");
  assert.doesNotMatch(historicalContextBranch, /\bgifts\b|giving_activities/i, "save_historical_context must never touch financial tables");
  assert.match(historicalContextBranch, /"unconfirmed"/, "a saved row must always be status='unconfirmed', never a value that could pass as confirmed");

  const confirmContactStart = commit.indexOf('decision.action === "confirm_contact"');
  const confirmContactEnd = commit.indexOf("} else if", confirmContactStart);
  const confirmContactBranch = commit.slice(confirmContactStart, confirmContactEnd);
  assert.doesNotMatch(confirmContactBranch, /donor_historical_context/, "confirming a real contact must never also write historical context");

  // --- 2: must not affect last-contact anywhere it is computed ---
  assert.doesNotMatch(relationshipRead, /donor_historical_context/, "the last-contact/relationship-updates read path must never reference historical context");
  // meeting-brief.ts DOES reference the table, but only for a COUNT, in a
  // query fully separate from the interactions query used for last contact.
  const meetingBriefInteractionQuery = /i\.donor_id = \?[\s\S]*?LIMIT 5/.exec(meetingBrief)?.[0] ?? "";
  assert.doesNotMatch(meetingBriefInteractionQuery, /donor_historical_context/, "the interactions query that drives last-contact must never reference historical context");
  assert.match(meetingBrief, /SELECT COUNT\(\*\) AS count FROM donor_historical_context WHERE donor_id = \? AND user_id = \? AND status = 'unconfirmed'/);

  // --- 6: donor profile displays it separately from the timeline ---
  assert.match(donorPage, /Historical context \(\{historicalContextRows\.length\}\)/);
  assert.match(donorPage, /Unconfirmed/);
  const timelineInvocation = /<UnifiedRelationshipTimeline .*?\/>/.exec(donorPage)?.[0] ?? "";
  assert.ok(timelineInvocation.length > 0, "the timeline component invocation must be found");
  assert.doesNotMatch(timelineInvocation, /historicalContextRows/, "historical context rows must never be passed into the interaction timeline");

  // --- schema: preserves exact text, source date, provenance,
  // classification, deterministic fingerprint; status is never 'confirmed' ---
  assert.match(migration, /`text` text NOT NULL/);
  assert.match(migration, /`source_date` integer/);
  assert.match(migration, /`classification` text NOT NULL/);
  assert.match(migration, /`source` text NOT NULL/);
  assert.match(migration, /`fingerprint` text NOT NULL/);
  assert.match(migration, /CHECK \(`status` IN \('unconfirmed','dismissed'\)\)/, "status must never include a 'confirmed' value -- confirming means writing a real interaction/recommendation instead");
  assert.match(migration, /CREATE UNIQUE INDEX `donor_historical_context_user_fingerprint_uidx` ON `donor_historical_context` \(`user_id`,`fingerprint`\)/);
  assert.match(migration, /CREATE INDEX `donor_historical_context_donor_date_idx` ON `donor_historical_context` \(`donor_id`,`created_at`\)/);
  assert.match(schema, /status: text\("status", \{ enum: \["unconfirmed", "dismissed"\] \}\)/);

  // --- UI: "Save as historical context" is offered on likely-completed,
  // historical, and ambiguous rows only -- never on donation notes or
  // future-planned rows. ---
  const section = (startMarker, endMarker) => ui.slice(ui.indexOf(startMarker), ui.indexOf(endMarker));
  const likelyCompletedSection = section("confirmCandidates.length > 0", "futurePlanned.length > 0");
  const futurePlannedSection = section("futurePlanned.length > 0 && <section", "historicalPlanned.length > 0 &&");
  const historicalSection = section("historicalPlanned.length > 0 && <section", "donationNotes.length > 0 &&");
  const donationNotesSection = section("donationNotes.length > 0 && <section", "ambiguousRows.length > 0 &&");
  const ambiguousSection = section("ambiguousRows.length > 0 && <section", "unmatchedCodeRows.length > 0");
  assert.match(likelyCompletedSection, /Save as historical context/);
  assert.match(historicalSection, /Save as historical context/);
  assert.match(ambiguousSection, /Save as historical context/);
  assert.doesNotMatch(futurePlannedSection, /Save as historical context/, "future planned rows must not offer a historical-context save path");
  assert.doesNotMatch(donationNotesSection, /Save as historical context/, "donation notes must never be saveable as historical context, including in the UI");
  assert.match(ui, /Likely completed contacts/, "the confirm-contact-candidate section must use the renamed, less-certain label");
  assert.doesNotMatch(ui, /Possible historical contact/, "the old label must be fully replaced");

  console.log("Monday historical context: schema, route, and UI checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
