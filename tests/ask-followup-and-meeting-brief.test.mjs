import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { buildMeetingBrief, askLine, matchAskFollowUps } from "../lib/relationships/meeting-brief-model.ts";
import { askFollowUpAction } from "../lib/capture/ask.ts";

// Ask/Solicitation v1 -- the two approved, previously-deferred
// enhancements (see docs/AI-HANDOFF.md "Next Approval Required" items 1
// and 2, now resolved): (A) Meeting Brief explicitly surfaces open Asks,
// independent of Suggested Action; (B) a fundraiser can add a follow-up
// reminder to an already-existing pending Ask. Scoped narrowly -- no
// Ask/Solicitation v1 redesign, no Relationship Intelligence change.
//
// Same repo convention as every other route/page test in this suite:
// route files import cloudflare:workers' `env` and can't be invoked
// directly in Node, so their D1-dependent behavior is verified two ways
// -- (1) the actual pure logic (matchAskFollowUps, buildMeetingBrief,
// askLine, askFollowUpAction) is imported and run directly, and (2) the
// route's own literal SQL/logic is mirrored against a real in-memory
// SQLite database (node:sqlite's DatabaseSync, built from the actual
// committed migrations -- matching tests/relationship-facts-schema.
// test.mjs's own established convention), combined with structural
// source-text assertions on the real, committed route/page files.

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const NOW = Math.floor(Date.parse("2026-08-23T12:00:00Z") / 1000);
const DAY = 86400;

function seed(database) {
  database.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run("u1", "owner@example.test", NOW, NOW);
  database.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, 'u1', 'live', ?, ?, ?)").run("d1", "Donor One", NOW, NOW);
}

// Mirrors app/api/asks/[id]/reminder/route.ts's own logic literally: the
// pre-check for an existing open reminder, then the INSERT if none
// exists -- so this test proves the actual shape the route uses, not a
// reimplementation of different logic.
function preCheckOpenReminder(database, askId, userId) {
  return database.prepare(`SELECT id, due_at FROM recommendations
    WHERE user_id = ? AND status = 'open' AND id LIKE ? ESCAPE '\\' LIMIT 1`)
    .get(userId, `ask-${askId.replace(/[\\%_]/g, "\\$&")}-%`);
}
function insertFollowUpReminder(database, { askId, donorId, userId, amountCents, purpose, dueAt, now }) {
  const existing = preCheckOpenReminder(database, askId, userId);
  if (existing) return { created: false, existing };
  const reminderId = `ask-${askId}-${crypto.randomUUID()}`;
  database.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 94, 'open', ?, ?, ?)`)
    .run(reminderId, donorId, userId, askFollowUpAction(amountCents, purpose), "Follow-up reminder added for this ask.", dueAt, now, now);
  return { created: true, reminderId };
}

async function run() {
  const meetingBriefPage = await read("app/donors/[id]/meeting-brief/page.tsx");
  const meetingBriefLib = await read("lib/relationships/meeting-brief.ts");
  const askReminderRoute = await read("app/api/asks/[id]/reminder/route.ts");
  const askManagement = await read("app/donors/[id]/AskManagement.tsx");

  const donor = { id: "d1", displayName: "Test Donor", donorCode: null, externalId: null, lastName: null, primaryFirstName: null, primaryName: null, spouseName: null, email: null, phone: null, homePhone: null, address: [] };
  const sampleRecommendation = { kind: "reconnect_contact_gap", action: "Reach out to reconnect", why: "It has been a while.", evidence: [], timing: null };

  // ================================================================
  // 1: a donor with one pending Ask sees it explicitly in Meeting
  // Brief -- present in the data model AND unconditionally rendered by
  // the page (not gated behind winning Suggested Action).
  // ================================================================
  {
    const brief = buildMeetingBrief(donor, [], [], [], [], 0, null, [], [{ id: "ask-1", amountCents: 2500000, purpose: "Building Campaign", askedAt: NOW - 13 * DAY, followUpDueAt: null }]);
    assert.equal(brief.openAsks.length, 1, "one pending ask must appear in the Meeting Brief model");
    assert.equal(brief.openAsks[0].amountCents, 2500000);
  }
  assert.match(meetingBriefPage, /brief\.openAsks\.length > 0 &&/, "the page must actually render brief.openAsks, not just carry it in the data model");
  assert.match(meetingBriefPage, /askLine\(item,/, "the page must use the shared askLine() formatter, never re-describe an ask differently");

  // ================================================================
  // 2: the pending Ask appears even when another, unrelated
  // recommendation wins Suggested Action -- openAsks is independent of
  // `recommendation`, and the page section is not nested inside/gated
  // by the recommendation card.
  // ================================================================
  {
    const brief = buildMeetingBrief(donor, [], [], [], [], 0, sampleRecommendation, [], [{ id: "ask-1", amountCents: 2500000, purpose: "Building Campaign", askedAt: NOW - 13 * DAY, followUpDueAt: null }]);
    assert.equal(brief.recommendation?.kind, "reconnect_contact_gap", "sanity check: a real, unrelated recommendation won Suggested Action");
    assert.equal(brief.openAsks.length, 1, "the open ask must still be present even though a different recommendation won Suggested Action");
  }
  // Structural: the Open Ask section is its own top-level sibling
  // <section>, never rendered as a child of the recommendation card.
  const recommendationSectionIndex = meetingBriefPage.indexOf("SUGGESTED ACTION");
  const recommendationSectionEnd = meetingBriefPage.indexOf("</section>", recommendationSectionIndex);
  const openAskSectionIndex = meetingBriefPage.indexOf("brief.openAsks.length > 0 &&");
  assert.ok(openAskSectionIndex > recommendationSectionEnd, "the Open Ask section must be structurally outside (a sibling of) the Suggested Action section, never nested inside it");

  // ================================================================
  // 3: a donor with no open Ask gets no empty/noisy Open Ask section --
  // conditionally rendered, never an always-shown empty-state card.
  // ================================================================
  {
    const brief = buildMeetingBrief(donor, [], [], [], [], 0, null, [], []);
    assert.deepEqual(brief.openAsks, [], "no pending asks must produce an empty openAsks array");
  }
  assert.doesNotMatch(meetingBriefPage, /OPEN ASKS?[\s\S]{0,200}meeting-empty/, "the Open Ask section must never render an empty-state placeholder -- it must simply not render at all when there are no open asks");

  // ================================================================
  // 4: a closed (committed/declined/withdrawn) Ask must never appear as
  // an open ask -- the data loader's own SQL is the actual guarantee.
  // ================================================================
  assert.match(meetingBriefLib, /FROM asks a JOIN donors d ON d\.id = a\.donor_id\s*WHERE a\.donor_id = \? AND a\.user_id = \? AND d\.owner_user_id = \? AND d\.data_source = 'live'\s*AND a\.status = 'pending'/, "Meeting Brief's open-ask query must filter to status = 'pending' only -- committed/declined/withdrawn asks must never be treated as open");

  // ================================================================
  // 5: multiple open Asks behave deterministically -- oldest-first order
  // is preserved end to end, and each ask's own follow-up match is
  // computed independently and correctly (earliest open reminder wins,
  // never an arbitrary one).
  // ================================================================
  {
    const asks = [
      { id: "askA", amountCents: 100000, purpose: "Dinner", askedAt: NOW - 30 * DAY },
      { id: "askB", amountCents: 200000, purpose: "Building", askedAt: NOW - 10 * DAY },
    ];
    const brief = buildMeetingBrief(donor, [], [], [], [], 0, null, [], asks.map((a) => ({ ...a, followUpDueAt: null })));
    assert.deepEqual(brief.openAsks.map((a) => a.id), ["askA", "askB"], "order must be preserved deterministically (oldest first, matching the SQL ORDER BY), never rearranged arbitrarily");

    const matches = matchAskFollowUps(
      ["askA", "askB"],
      [
        { id: "ask-askA-reminder-late", dueAt: NOW + 20 * DAY },
        { id: "ask-askA-reminder-early", dueAt: NOW + 5 * DAY },
        { id: "ask-askB-reminder", dueAt: NOW + 8 * DAY },
      ],
    );
    assert.equal(matches.get("askA")?.id, "ask-askA-reminder-early", "when an ask somehow has more than one open reminder, the EARLIEST due date must win, never an arbitrary first match");
    assert.equal(matches.get("askB")?.id, "ask-askB-reminder");
  }

  // ================================================================
  // 6-7: a follow-up can be added to an existing pending Ask, and the
  // created reminder is attached to the correct donor and ask (via the
  // established id-prefix convention -- the schema has no ask_id column,
  // confirmed live during investigation before implementing).
  // ================================================================
  {
    const database = freshDatabase();
    seed(database);
    database.prepare("INSERT INTO asks (id, user_id, donor_id, amount_cents, purpose, status, asked_at, created_at, updated_at) VALUES ('ask-1', 'u1', 'd1', 2500000, 'Building Campaign', 'pending', ?, ?, ?)").run(NOW - 13 * DAY, NOW, NOW);

    const result = insertFollowUpReminder(database, { askId: "ask-1", donorId: "d1", userId: "u1", amountCents: 2500000, purpose: "Building Campaign", dueAt: NOW + 26 * DAY, now: NOW });
    assert.equal(result.created, true, "adding a follow-up to a pending ask with no existing reminder must succeed");

    const row = database.prepare("SELECT id, donor_id, user_id, status, due_at, action FROM recommendations WHERE id = ?").get(result.reminderId);
    assert.ok(row, "the reminder row must actually exist");
    assert.equal(row.donor_id, "d1", "the reminder must be attached to the correct donor");
    assert.ok(row.id.startsWith("ask-ask-1-"), "the reminder id must carry the ask-<askId>- prefix, the schema's actual association mechanism");
    assert.equal(row.status, "open");
    assert.equal(row.due_at, NOW + 26 * DAY);
    assert.equal(row.action, askFollowUpAction(2500000, "Building Campaign"), "the reminder text must use the same shared askFollowUpAction() phrasing every other ask reminder uses");
  }

  // ================================================================
  // 8: adding a follow-up must leave every Ask field unchanged.
  // ================================================================
  {
    const database = freshDatabase();
    seed(database);
    database.prepare("INSERT INTO asks (id, user_id, donor_id, amount_cents, purpose, status, asked_at, note, created_at, updated_at) VALUES ('ask-1', 'u1', 'd1', 500000, 'Plaque', 'pending', ?, 'original note', ?, ?)").run(NOW - 5 * DAY, NOW, NOW);
    const before = { ...database.prepare("SELECT amount_cents, purpose, status, asked_at, note FROM asks WHERE id = 'ask-1'").get() };

    insertFollowUpReminder(database, { askId: "ask-1", donorId: "d1", userId: "u1", amountCents: 500000, purpose: "Plaque", dueAt: NOW + 7 * DAY, now: NOW });

    const after = { ...database.prepare("SELECT amount_cents, purpose, status, asked_at, note FROM asks WHERE id = 'ask-1'").get() };
    assert.deepEqual(after, before, "the ask row itself must be byte-for-byte unchanged after adding a follow-up");
  }
  // Structural: the route must contain no UPDATE of the asks table at
  // all -- a stronger guarantee than "the values happen to match."
  assert.doesNotMatch(askReminderRoute, /UPDATE asks SET/, "the follow-up route must never write to the asks table -- it only ever inserts a recommendations row");

  // ================================================================
  // 9: duplicate/retry safety -- a second attempt to add a follow-up
  // while one is already open must not create a duplicate reminder.
  // ================================================================
  {
    const database = freshDatabase();
    seed(database);
    database.prepare("INSERT INTO asks (id, user_id, donor_id, amount_cents, purpose, status, asked_at, created_at, updated_at) VALUES ('ask-1', 'u1', 'd1', 500000, 'Plaque', 'pending', ?, ?, ?)").run(NOW - 5 * DAY, NOW, NOW);

    const first = insertFollowUpReminder(database, { askId: "ask-1", donorId: "d1", userId: "u1", amountCents: 500000, purpose: "Plaque", dueAt: NOW + 7 * DAY, now: NOW });
    assert.equal(first.created, true);
    // Simulate a double-submit/retry -- the exact same call again.
    const second = insertFollowUpReminder(database, { askId: "ask-1", donorId: "d1", userId: "u1", amountCents: 500000, purpose: "Plaque", dueAt: NOW + 9 * DAY, now: NOW + 60 });
    assert.equal(second.created, false, "a retry while an open reminder already exists must not create a second one");
    assert.equal(second.existing.id, first.reminderId, "the retry must find and report the SAME existing reminder, not a new one");

    const openCount = database.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE id LIKE 'ask-ask-1-%' AND status = 'open'").get().n;
    assert.equal(openCount, 1, "exactly one open reminder must exist for this ask after a retry, never two");
  }

  // ================================================================
  // 10: an existing active follow-up is handled coherently -- shown,
  // with editing via the EXISTING generic reschedule path, never a
  // second creation. Verified both at the data layer (the pre-check
  // above) and structurally (the UI must reuse RescheduleButton, never
  // build a second reschedule mechanism, and must not show the "add"
  // trigger when one already exists).
  // ================================================================
  assert.match(askManagement, /import \{ RescheduleButton \} from "\.\.\/\.\.\/components\/RescheduleButton"/, "the Ask card must reuse the EXISTING RescheduleButton component, never a second reschedule mechanism");
  assert.match(askManagement, /if \(savedReminderId && savedDueAt !== null\) \{/, "when a follow-up already exists, the card must render its info and the reschedule control, not the add-follow-up trigger");
  assert.match(askManagement, /<RescheduleButton recommendationId=\{savedReminderId\}/, "the existing follow-up's own reschedule control must be the shared RescheduleButton, bound to the real reminder id");

  // ================================================================
  // 11: completed/historical follow-ups remain historical -- a
  // previously-completed reminder for this ask must never block (or be
  // disturbed by) adding a new one, and must remain readable afterward.
  // ================================================================
  {
    const database = freshDatabase();
    seed(database);
    database.prepare("INSERT INTO asks (id, user_id, donor_id, amount_cents, purpose, status, asked_at, created_at, updated_at) VALUES ('ask-1', 'u1', 'd1', 500000, 'Plaque', 'pending', ?, ?, ?)").run(NOW - 40 * DAY, NOW, NOW);
    const oldReminderId = "ask-ask-1-old";
    database.prepare("INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at) VALUES (?, 'd1', 'u1', 'Follow up', 'Old cycle', 94, 'completed', ?, ?, ?)").run(oldReminderId, NOW - 20 * DAY, NOW - 40 * DAY, NOW - 20 * DAY);

    const result = insertFollowUpReminder(database, { askId: "ask-1", donorId: "d1", userId: "u1", amountCents: 500000, purpose: "Plaque", dueAt: NOW + 7 * DAY, now: NOW });
    assert.equal(result.created, true, "a completed reminder from a prior cycle must never block adding a new follow-up");

    const oldStillThere = database.prepare("SELECT status FROM recommendations WHERE id = ?").get(oldReminderId);
    assert.equal(oldStillThere.status, "completed", "the old completed reminder must remain exactly as it was -- untouched, still historical");
    const total = database.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE id LIKE 'ask-ask-1-%'").get().n;
    assert.equal(total, 2, "both the historical completed reminder and the new open one must coexist -- history is never deleted or overwritten");
  }

  // ================================================================
  // 12: adding a follow-up must never touch Relationship Intelligence
  // or unrelated donor data -- structural guarantee (the route contains
  // no such reference at all), plus a direct D1 check that an unrelated
  // donor field is untouched.
  // ================================================================
  for (const forbidden of ["donor_relationship_facts", "fact-accept", "relationship_summary", "institutional_memory", "UPDATE donors", "giving_activities", "\\bgifts\\b"]) {
    assert.doesNotMatch(askReminderRoute, new RegExp(forbidden), `the follow-up route must never reference ${forbidden}`);
  }
  {
    const database = freshDatabase();
    seed(database);
    database.prepare("UPDATE donors SET relationship_summary = 'Untouched summary.' WHERE id = 'd1'").run();
    database.prepare("INSERT INTO asks (id, user_id, donor_id, amount_cents, purpose, status, asked_at, created_at, updated_at) VALUES ('ask-1', 'u1', 'd1', 500000, 'Plaque', 'pending', ?, ?, ?)").run(NOW - 5 * DAY, NOW, NOW);
    insertFollowUpReminder(database, { askId: "ask-1", donorId: "d1", userId: "u1", amountCents: 500000, purpose: "Plaque", dueAt: NOW + 7 * DAY, now: NOW });
    const donorRow = database.prepare("SELECT relationship_summary FROM donors WHERE id = 'd1'").get();
    assert.equal(donorRow.relationship_summary, "Untouched summary.", "unrelated donor data (relationship_summary) must remain exactly unchanged");
  }

  console.log("ask-followup-and-meeting-brief: ok");
}

await run();
