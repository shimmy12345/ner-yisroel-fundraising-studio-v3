import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  validateAskAmountCents,
  validateAskPurpose,
  validateAskNote,
  askDescriptor,
  askFollowUpAction,
  planAskUpdate,
  ASK_TERMINAL_STATUSES,
} from "../lib/capture/ask.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";
import { buildMeetingBrief, askLine, matchAskFollowUps } from "../lib/relationships/meeting-brief-model.ts";
import { STAGING_RESET_TABLE_ORDER } from "../lib/operations/staging-reset.ts";
import { PRODUCTION_BASELINE_TABLES, PRODUCTION_BASELINE_VERIFIED } from "../lib/data-health/production-baseline.ts";

// Phase 1 Ask/Solicitation feature. Pure decision logic (validation,
// status transitions, evidence/recommendation wiring, schema/merge/reset
// behavior against a real in-memory SQLite database) is tested
// behaviorally, matching this codebase's own established pattern
// (lib/donors/merge.ts's mergeFieldValues/validateMergeChoices,
// scripts/relationship-summary-cleanup-preview.mjs's planApply/
// executePlan). API-route-level concerns with no D1/env test harness in
// this repo (ownership checks, the shared/multi-donor safety boundary,
// route wiring) are verified by reading the real, committed source, the
// same convention tests/activity-editing.test.mjs and
// tests/donor-merge.test.mjs already use for the same reason.

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const NOW = Math.floor(Date.parse("2026-08-19T12:00:00Z") / 1000);
const DAY = 86400;

const emptyEvidenceInput = {
  donorId: "donor-empty", mostRecentPaidGift: null, openPledge: null, lastCompletedInteraction: null,
  lastContactAt: null, lastSubstantiveContactAt: null, openReminder: null, openAsk: null, relationshipSummary: null,
  institutionalMemory: null, historicalContext: [], yahrtzeits: [], importantDates: [],
};

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(read(`drizzle/${file}`));
  }
  return database;
}

function seedUserAndDonors(database) {
  database.exec(`INSERT INTO users (id,email,timezone,household_import_review_mode,created_at,updated_at) VALUES ('user-1','owner@example.test','America/New_York','auto_unchanged',${NOW},${NOW})`);
  database.exec(`INSERT INTO donors (id,owner_user_id,data_source,display_name,created_at,updated_at) VALUES ('donor-a','user-1','live','Donor A',${NOW},${NOW})`);
  database.exec(`INSERT INTO donors (id,owner_user_id,data_source,display_name,created_at,updated_at) VALUES ('donor-b','user-1','live','Donor B',${NOW},${NOW})`);
}

async function run() {
  // --- 1: ask creation with amount -- integer cents, never floating point. ---
  {
    const result = validateAskAmountCents(500000);
    assert.deepEqual(result, { ok: true, amountCents: 500000 });
    assert.equal(askDescriptor(500000, "Plaque"), "$5,000 Plaque");
  }

  // --- 2: ask creation without amount -- a legitimate ask can have no
  // specific figure ("asked him to support the dinner"). ---
  {
    assert.deepEqual(validateAskAmountCents(undefined), { ok: true, amountCents: null });
    assert.deepEqual(validateAskAmountCents(null), { ok: true, amountCents: null });
    assert.equal(askDescriptor(null, "Dinner sponsorship"), "Dinner sponsorship");
  }

  // --- 3: ask created from an interaction gets the correct
  // source_interaction_id (the interaction just created in the same
  // atomic write, never a caller-supplied id). ---
  {
    const interactionsRoute = read("app/api/interactions/route.ts");
    assert.match(interactionsRoute, /INSERT INTO asks[\s\S]{0,400}source_interaction_id/);
    assert.match(interactionsRoute, /\.bind\(askId, userId, donorId, askAmount\.amountCents, askPurposeResult\.purpose, occurredAtEpoch, askNoteResult\.note, interactionId, now, now\)/, "source_interaction_id must bind the just-created interactionId, not a caller-supplied value");
  }

  // --- 4: direct Ask creation works -- a standalone route exists and
  // always sets source_interaction_id NULL (no interaction required). ---
  {
    const askRoute = read("app/api/asks/route.ts");
    assert.match(askRoute, /export async function POST/);
    assert.match(askRoute, /INSERT INTO asks[\s\S]{0,200}source_interaction_id[\s\S]{0,200}NULL/);
    assert.match(askRoute, /status: "pending"|'pending'/, "status must always be pending on direct creation, never a caller choice");
  }

  // --- 5/6: ask creation and mutation require an owned, live donor --
  // the ownership predicate is bound to the AUTHENTICATED profile's id
  // (from ensureUserProfile), never a client-supplied value, so a donor
  // belonging to a different user can never be matched (cross-user access
  // rejected the same way every other route in this app rejects it). ---
  {
    const askRoute = read("app/api/asks/route.ts");
    const askIdRoute = read("app/api/asks/[id]/route.ts");
    const interactionsRoute = read("app/api/interactions/route.ts");
    for (const source of [askRoute, interactionsRoute]) {
      assert.match(source, /SELECT id FROM donors WHERE id = \? AND owner_user_id = \? AND data_source = 'live'/);
      assert.match(source, /\.bind\(donorId, userId\)/);
    }
    assert.match(askIdRoute, /d\.owner_user_id = \? AND d\.data_source = 'live'/);
    assert.match(askIdRoute, /\.bind\(id, userId, userId\)/);
  }

  // --- 7: invalid amount rejected -- negative, fractional, and exactly
  // zero are all invalid; only a positive integer or "no amount" is valid. ---
  {
    assert.deepEqual(validateAskAmountCents(-100), { ok: false });
    assert.deepEqual(validateAskAmountCents(1.5), { ok: false });
    assert.deepEqual(validateAskAmountCents(0), { ok: false });
    assert.deepEqual(validateAskAmountCents("500"), { ok: false });
  }

  // --- 8: only committed/declined/withdrawn are valid PATCH statuses --
  // 'pending' (reopening) and anything unrecognized are rejected. ---
  {
    assert.deepEqual([...ASK_TERMINAL_STATUSES].sort(), ["committed", "declined", "withdrawn"]);
    const pendingAsk = { amountCents: 500000, purpose: "Plaque", status: "pending", note: null };
    const reopen = planAskUpdate(pendingAsk, { status: "pending" });
    assert.equal(reopen.ok, false);
    const bogus = planAskUpdate(pendingAsk, { status: "bogus" });
    assert.equal(bogus.ok, false);
  }

  // --- 9: pending -> committed. ---
  {
    const pendingAsk = { amountCents: 500000, purpose: "Plaque", status: "pending", note: null };
    const plan = planAskUpdate(pendingAsk, { status: "committed" });
    assert.equal(plan.ok, true);
    assert.equal(plan.changed, true);
    assert.deepEqual(plan.changedFields, ["status"]);
    assert.equal(plan.after.status, "committed");
    assert.equal(plan.action, "status_changed");
    // Already-terminal: a second transition attempt fails closed (no
    // reopening in Phase 1).
    const committedAsk = { ...pendingAsk, status: "committed" };
    const second = planAskUpdate(committedAsk, { status: "declined" });
    assert.equal(second.ok, false);
    assert.equal(second.httpStatus, 409);
  }

  // --- 10: pending -> declined. ---
  {
    const pendingAsk = { amountCents: 1000000, purpose: null, status: "pending", note: null };
    const plan = planAskUpdate(pendingAsk, { status: "declined" });
    assert.equal(plan.ok, true);
    assert.equal(plan.changed, true);
    assert.equal(plan.after.status, "declined");
  }

  // --- 11: withdrawn requires a reason (stored in the existing `note`
  // column, not a new one). ---
  {
    const pendingAsk = { amountCents: null, purpose: "Dinner", status: "pending", note: null };
    const noReason = planAskUpdate(pendingAsk, { status: "withdrawn" });
    assert.equal(noReason.ok, false);
    assert.match(noReason.error, /reason/i);
    const blankReason = planAskUpdate(pendingAsk, { status: "withdrawn", note: "   " });
    assert.equal(blankReason.ok, false);
    const withReason = planAskUpdate(pendingAsk, { status: "withdrawn", note: "Donor moved out of state." });
    assert.equal(withReason.ok, true);
    assert.equal(withReason.after.status, "withdrawn");
    assert.equal(withReason.after.note, "Donor moved out of state.");
  }

  // --- 12: ask_changes is written for every meaningful mutation, and
  // ONLY for a meaningful mutation -- a no-op PATCH changes nothing and
  // produces no audit row (the route checks `plan.changed` before ever
  // building the INSERT INTO ask_changes statement). ---
  {
    const pendingAsk = { amountCents: 500000, purpose: "Plaque", status: "pending", note: null };
    const amountOnly = planAskUpdate(pendingAsk, { amountCents: 750000 });
    assert.equal(amountOnly.ok, true);
    assert.deepEqual(amountOnly.changedFields, ["amountCents"]);
    assert.equal(amountOnly.action, "updated", "a non-status change must be logged as 'updated', not 'status_changed'");
    const noop = planAskUpdate(pendingAsk, { amountCents: 500000, purpose: "Plaque" });
    assert.deepEqual(noop, { ok: true, changed: false });
    const askIdRoute = read("app/api/asks/[id]/route.ts");
    assert.match(askIdRoute, /if \(!plan\.changed\)/, "the route must check plan.changed before writing any ask_changes row");
  }

  // --- 13: no giving_activities/gifts mutation from Ask status changes --
  // marking an ask committed/declined/withdrawn never touches the
  // financial-system-of-record tables, in either ask route. ---
  {
    const askRoute = read("app/api/asks/route.ts");
    const askIdRoute = read("app/api/asks/[id]/route.ts");
    for (const source of [askRoute, askIdRoute]) {
      assert.doesNotMatch(source, /(INSERT INTO|UPDATE)\s+(giving_activities|gifts)\b/i, "no write statement may ever target giving_activities/gifts from an ask route");
    }
  }

  // --- 14: the interaction-capture reminder behavior for a NON-ask
  // interaction is unchanged -- still "activity-<interactionId>", still
  // uses extracted.nextAction. ---
  {
    const interactionsRoute = read("app/api/interactions/route.ts");
    assert.match(interactionsRoute, /askId \? `ask-\$\{askId\}-\$\{crypto\.randomUUID\(\)\}` : `activity-\$\{interactionId\}`/);
    assert.match(interactionsRoute, /askId \? askFollowUpAction\(askAmount\.amountCents, askPurposeResult\.purpose\) : extracted\.nextAction/);
  }

  // --- 15: a structured pending Ask feeds the shared recommendation
  // engine as CONFIRMED evidence -- a real candidate, not narrative text. ---
  {
    const evidence = buildRecommendationEvidence({ ...emptyEvidenceInput, openAsk: { id: "ask-1", amountCents: 1000000, purpose: "dinner sponsorship", askedAt: NOW - 5 * DAY } }, NOW, "America/New_York");
    const candidates = generateCandidates(evidence);
    const openAskCandidate = candidates.find((item) => item.kind === "open_ask");
    assert.ok(openAskCandidate, "a pending ask must produce an open_ask candidate");
    assert.equal(openAskCandidate.certainty, "confirmed");
    assert.match(openAskCandidate.action, /\$10,000 dinner sponsorship ask/);
  }

  // --- 16: a fresh ask (made today, no explicit reminder) does not
  // produce premature nagging -- low confidence, near-zero urgency. ---
  {
    const evidence = buildRecommendationEvidence({ ...emptyEvidenceInput, openAsk: { id: "ask-fresh", amountCents: 500000, purpose: "plaque", askedAt: NOW } }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.equal(candidate.confidence, "low");
    assert.ok(candidate.urgency < 0.05, `urgency should be near zero for a same-day ask, got ${candidate.urgency}`);
  }

  // --- 17: an old pending ask becomes useful, higher-confidence
  // recommendation evidence, and can win the overall recommendation when
  // nothing else outranks it. ---
  {
    const evidence = buildRecommendationEvidence({ ...emptyEvidenceInput, openAsk: { id: "ask-stale", amountCents: 500000, purpose: "plaque", askedAt: NOW - 90 * DAY } }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.equal(candidate.confidence, "medium");
    assert.ok(candidate.urgency > 0.4, `urgency should have ramped up for a 90-day-old ask, got ${candidate.urgency}`);
    const winner = buildDonorRecommendation(evidence);
    assert.equal(winner?.kind, "open_ask");
  }

  // --- 18: an open ask appears in the Meeting Brief model, factually,
  // never called an "opportunity." ---
  {
    const brief = buildMeetingBrief(
      { id: "donor-1", displayName: "Test Donor", donorCode: null, externalId: null, lastName: null, primaryFirstName: null, primaryName: null, spouseName: null, email: null, phone: null, homePhone: null, address: [] },
      [], [], [], [], 0, null, [],
      [{ id: "ask-1", amountCents: 1000000, purpose: "dinner sponsorship", askedAt: NOW - 18 * DAY }],
    );
    assert.equal(brief.openAsks.length, 1);
    assert.equal(brief.openAsks[0].amountCents, 1000000);
    const line = askLine(brief.openAsks[0], (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10));
    assert.match(line, /^Open ask: \$10,000 for dinner sponsorship, pending since/);
    assert.doesNotMatch(line, /opportunity/i);
  }

  // --- 19: donor merge reassigns an ask (and its ask_changes audit rows)
  // to the surviving donor -- verified against a real in-memory SQLite
  // database built from the actual committed migrations, running the
  // exact UPDATE statements the merge route itself contains. ---
  {
    const database = freshDatabase();
    seedUserAndDonors(database);
    database.exec(`INSERT INTO asks (id,user_id,donor_id,amount_cents,purpose,status,asked_at,created_at,updated_at) VALUES ('ask-1','user-1','donor-b',500000,'Plaque','pending',${NOW},${NOW},${NOW})`);
    database.exec(`INSERT INTO ask_changes (id,ask_id,user_id,donor_id,action,changed_fields,after_json,created_at) VALUES ('change-1','ask-1','user-1','donor-b','created','["amountCents"]','{}',${NOW})`);
    database.prepare("UPDATE asks SET donor_id=? WHERE donor_id=? AND user_id=?").run("donor-a", "donor-b", "user-1");
    database.prepare("UPDATE ask_changes SET donor_id=? WHERE donor_id=? AND user_id=?").run("donor-a", "donor-b", "user-1");
    assert.equal(database.prepare("SELECT donor_id FROM asks WHERE id='ask-1'").get().donor_id, "donor-a");
    assert.equal(database.prepare("SELECT donor_id FROM ask_changes WHERE id='change-1'").get().donor_id, "donor-a");
    const mergeRoute = read("app/api/donors/merge/route.ts");
    assert.match(mergeRoute, /UPDATE asks SET donor_id=\?/);
    assert.match(mergeRoute, /UPDATE ask_changes SET donor_id=\?/);
  }

  // --- 20: multiple pending asks per donor are allowed -- no unique
  // constraint enforces "one open ask," verified by actually inserting
  // two against the real schema. ---
  {
    const database = freshDatabase();
    seedUserAndDonors(database);
    database.exec(`INSERT INTO asks (id,user_id,donor_id,amount_cents,purpose,status,asked_at,created_at,updated_at) VALUES ('ask-1','user-1','donor-a',500000,'Plaque','pending',${NOW},${NOW},${NOW})`);
    database.exec(`INSERT INTO asks (id,user_id,donor_id,amount_cents,purpose,status,asked_at,created_at,updated_at) VALUES ('ask-2','user-1','donor-a',1000000,'Dinner','pending',${NOW},${NOW},${NOW})`);
    const pending = database.prepare("SELECT COUNT(*) count FROM asks WHERE donor_id='donor-a' AND status='pending'").get();
    assert.equal(pending.count, 2);
  }

  // --- 21: a null amount never displays as "$0" -- across the
  // descriptor, the reminder/Suggested Action text, and the Meeting Brief
  // line. ---
  {
    assert.equal(askDescriptor(null, null), "pending");
    assert.doesNotMatch(askDescriptor(null, "Dinner"), /\$0/);
    assert.doesNotMatch(askFollowUpAction(null, null), /\$0/);
    const line = askLine({ id: "x", amountCents: null, purpose: null, askedAt: NOW }, (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10));
    assert.doesNotMatch(line, /\$0/);
    const donorPage = await readFile(new URL("../app/donors/[id]/AskManagement.tsx", import.meta.url), "utf8");
    assert.match(donorPage, /ask\.amountCents !== null &&/, "the donor-page card must gate the amount line on non-null, never render a fallback $0");
  }

  // --- 22: a shared/multi-donor interaction must NEVER accidentally
  // create N asks -- the shared route has no ask-related code at all. ---
  {
    const sharedRoute = read("app/api/interactions/shared/route.ts");
    assert.doesNotMatch(sharedRoute, /madeAsk/);
    assert.doesNotMatch(sharedRoute, /INSERT INTO asks/);
  }

  // --- 23: existing interaction capture remains backward-compatible when
  // "Did you make an ask?" is No (the default) -- the ask fields are only
  // ever spread into the request body when explicitly true, and only for
  // a brand-new (non-edit) interaction. ---
  {
    const captureExperience = read("app/capture/CaptureExperience.tsx");
    assert.match(captureExperience, /const \[madeAsk, setMadeAsk\] = useState\(false\)/, "madeAsk must default to false");
    assert.match(captureExperience, /\.\.\.\(!initialActivity && madeAsk \? \{/, "ask fields must only be sent for a new interaction with an explicit Yes");
  }

  // --- 24: staging-reset table-enumeration guardrails include the new
  // tables (the existing self-check test in tests/staging-reset.test.mjs
  // additionally proves this list is exhaustive). ---
  {
    assert.ok(STAGING_RESET_TABLE_ORDER.includes("asks"));
    assert.ok(STAGING_RESET_TABLE_ORDER.includes("ask_changes"));
    // ask_changes (child, references ask_id) must be deleted before asks.
    assert.ok(STAGING_RESET_TABLE_ORDER.indexOf("ask_changes") < STAGING_RESET_TABLE_ORDER.indexOf("asks"));
  }

  // --- 25: the production baseline was regenerated correctly -- it
  // includes both new tables and the manifest is internally consistent
  // (tests/production-baseline.test.mjs's own "0032 asks migration" test
  // additionally pins the exact migration count/hash relationship). ---
  {
    assert.ok(PRODUCTION_BASELINE_TABLES.includes("asks"));
    assert.ok(PRODUCTION_BASELINE_TABLES.includes("ask_changes"));
    assert.equal(PRODUCTION_BASELINE_VERIFIED, true);
  }

  // --- 26: post-Ask gift/pledge activity -- the real Rovinsky pattern
  // (a $5,000 ask followed the very next day by a $5,000 completed
  // gift) must switch the recommendation from an unconditional "follow
  // up" to a verification-oriented one. Scoring inputs are unchanged
  // from the default case -- this is a wording change only, never a
  // ranking change. The Ask's own status is untouched anywhere in this
  // fix -- resolving it remains a human decision. ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-rovinsky", amountCents: 500000, purpose: "plaque in memory of his wife", askedAt: NOW - 331 * DAY },
      mostRecentPaidGift: { giftSource: "giving_activity", giftId: "gift-rovinsky", amountCents: 500000, occurredAt: NOW - 330 * DAY, campaign: null, description: null, acknowledged: false },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.ok(candidate, "an old ask with a later gift must still produce an open_ask candidate");
    assert.match(candidate.action, /Confirm whether the \$5,000 plaque in memory of his wife ask is already resolved/);
    assert.match(candidate.why, /\$5,000 gift was recorded/);
    assert.doesNotMatch(candidate.action, /Follow up on/, "must not use the unconditional follow-up wording once a later gift exists");
    assert.equal(candidate.specificity, 0.75);
    assert.equal(candidate.recency, 0.7);
    assert.ok(candidate.urgency > 0.9, `urgency should still ramp the same way as the default case, got ${candidate.urgency}`);
  }

  // --- 27: post-Ask gift/pledge activity -- the real Pfeiffer pattern
  // (a $10,000 ask followed 1.5 days later by a $5,000 completed gift,
  // half the amount). "Already resolved?" verification wording does not
  // require an exact amount match -- only that something happened since
  // the ask that the ask's own "still pending" framing doesn't reflect. ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-pfeiffer", amountCents: 1000000, purpose: null, askedAt: NOW - 345 * DAY },
      mostRecentPaidGift: { giftSource: "giving_activity", giftId: "gift-pfeiffer", amountCents: 500000, occurredAt: NOW - 343 * DAY, campaign: null, description: null, acknowledged: false },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.ok(candidate);
    assert.match(candidate.action, /Confirm whether the \$10,000 ask is already resolved/);
    assert.match(candidate.why, /\$5,000 gift was recorded/);
  }

  // --- 28: a genuinely unresolved old Ask with NO post-Ask gift/pledge
  // activity still produces the existing, unconditional follow-up
  // wording -- this fix must not become a blanket "always verify" for
  // every old ask, only the ones with real evidence in tension. ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-genuinely-stale", amountCents: 750000, purpose: "annual campaign", askedAt: NOW - 300 * DAY },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.ok(candidate);
    assert.match(candidate.action, /Follow up on the \$7,500 annual campaign ask/);
    assert.doesNotMatch(candidate.action, /Confirm whether/);
  }

  // --- 29: a gift recorded BEFORE the Ask (ordinary prior giving
  // history) must not trigger verification wording -- only activity
  // strictly AFTER the Ask's own askedAt is relevant tension. ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-with-prior-gift", amountCents: 200000, purpose: null, askedAt: NOW - 100 * DAY },
      mostRecentPaidGift: { giftSource: "giving_activity", giftId: "gift-prior", amountCents: 100000, occurredAt: NOW - 200 * DAY, campaign: null, description: null, acknowledged: true },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.match(candidate.action, /Follow up on the \$2,000 ask/);
  }

  // --- 30: pledge activity (not just a paid gift) recorded after the
  // Ask also triggers verification wording. ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-with-later-pledge", amountCents: 1000000, purpose: null, askedAt: NOW - 200 * DAY },
      openPledge: { balanceCents: 500000, campaign: null, description: null, activityDate: NOW - 150 * DAY, activePaymentPlan: null },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.match(candidate.action, /Confirm whether the \$10,000 ask is already resolved/);
    assert.match(candidate.why, /pledge activity was recorded/i);
  }

  // --- 31: an Ask with an ACTIVE FUTURE follow-up reminder (the
  // fundraiser's own explicit, dated decision, matched via the existing
  // "ask-<askId>-" convention) must not generate the generic open_ask
  // suggestion at all -- it defers entirely to the scheduled reminder,
  // never silently overriding it with "follow up now." ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-scheduled", amountCents: 500000, purpose: null, askedAt: NOW - 200 * DAY, activeFollowUpDueAt: NOW + 14 * DAY },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.equal(candidate, undefined, "a future-scheduled follow-up must suppress the generic open_ask candidate entirely");
  }

  // --- 32: an OVERDUE Ask follow-up reminder must NOT suppress open_ask
  // generation -- overdue work already wins the homepage/agenda's own
  // due-date ranking (rank 0) ahead of any recommendation-kind
  // candidate regardless; only a not-yet-due follow-up needed deferral. ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-overdue-followup", amountCents: 500000, purpose: null, askedAt: NOW - 200 * DAY, activeFollowUpDueAt: NOW - 3 * DAY },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.ok(candidate, "an overdue follow-up must not suppress the open_ask candidate");
  }

  // --- 33: a follow-up due TODAY must also not suppress open_ask (rank
  // 2 already beats a generic Suggested Action on its own). ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-due-today", amountCents: 500000, purpose: null, askedAt: NOW - 200 * DAY, activeFollowUpDueAt: NOW },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.ok(candidate, "a follow-up due today must not suppress the open_ask candidate");
  }

  // --- 34: a COMPLETED historical reminder must not permanently
  // suppress the Ask -- matchAskFollowUps only ever sees status='open'
  // rows (see live-data.ts/meeting-brief.ts's own queries), so a
  // completed reminder simply never populates activeFollowUpDueAt in
  // the first place; modeled here as null, same as "never had one." ---
  {
    const evidence = buildRecommendationEvidence({
      ...emptyEvidenceInput,
      openAsk: { id: "ask-completed-followup", amountCents: 500000, purpose: null, askedAt: NOW - 200 * DAY, activeFollowUpDueAt: null },
    }, NOW, "America/New_York");
    const candidate = generateCandidates(evidence).find((item) => item.kind === "open_ask");
    assert.ok(candidate, "a completed (no longer open) reminder must not suppress the open_ask candidate");
  }

  // --- 35: matchAskFollowUps itself -- an unrelated reminder (a
  // different ask's id prefix, or a non-ask activity reminder) must
  // never match a different ask. ---
  {
    const matches = matchAskFollowUps(
      ["ask-x"],
      [{ id: "ask-y-some-uuid-here", dueAt: NOW + 5 * DAY }, { id: "activity-unrelated-uuid", dueAt: NOW + 1 * DAY }],
    );
    assert.equal(matches.get("ask-x"), null, "an unrelated reminder id must never match a different ask's id prefix");
  }

  console.log("Ask/Solicitation feature (Phase 1) checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
