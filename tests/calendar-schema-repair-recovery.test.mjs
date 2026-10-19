import assert from "node:assert/strict";
import test from "node:test";
import {
  CALENDAR_EVENT_LINKS_TABLE,
  CALENDAR_EVENT_LINK_HISTORY_TABLE,
  buildCalendarTablesRecoveryStatements,
} from "../lib/operations/calendar-schema-repair-recovery.ts";

// Pure, offline parsing coverage for the recovery batch builder -- no
// wrangler, no network, no D1. The real local-D1 rehearsal of actually
// APPLYING this batch lives in
// tests/calendar-schema-repair-rehearsal.test.mjs (Linux CI only); this
// file proves the TEXT EXTRACTION itself is correct against a
// representative `wrangler d1 export`-shaped backup (double-quoted
// identifiers, one statement per terminating `;`), including that it
// correctly ignores unrelated tables and fails closed on a missing
// CREATE TABLE.

const SAMPLE_BACKUP = [
  `CREATE TABLE "users" (`,
  `  "id" text PRIMARY KEY NOT NULL`,
  `);`,
  `INSERT INTO "users" (id) VALUES('u1');`,
  `CREATE TABLE "${CALENDAR_EVENT_LINKS_TABLE}" (`,
  `  "id" text PRIMARY KEY NOT NULL,`,
  `  "sync_status" text DEFAULT 'pending' NOT NULL`,
  `);`,
  `INSERT INTO "${CALENDAR_EVENT_LINKS_TABLE}" (id,sync_status) VALUES('link-1','pending');`,
  `INSERT INTO "${CALENDAR_EVENT_LINKS_TABLE}" (id,sync_status) VALUES('link-2','synced');`,
  `CREATE UNIQUE INDEX "calendar_event_links_interaction_uidx" ON "${CALENDAR_EVENT_LINKS_TABLE}" ("interaction_id");`,
  `CREATE TABLE "${CALENDAR_EVENT_LINK_HISTORY_TABLE}" (`,
  `  "id" text PRIMARY KEY NOT NULL,`,
  `  "link_id" text NOT NULL REFERENCES "${CALENDAR_EVENT_LINKS_TABLE}"("id")`,
  `);`,
  `INSERT INTO "${CALENDAR_EVENT_LINK_HISTORY_TABLE}" (id,link_id) VALUES('hist-1','link-1');`,
  `CREATE INDEX "calendar_event_link_history_cleanup_idx" ON "${CALENDAR_EVENT_LINK_HISTORY_TABLE}" ("cleanup_needed","cleanup_status");`,
  `CREATE TABLE "unrelated_table" (`,
  `  "id" text PRIMARY KEY NOT NULL`,
  `);`,
  `INSERT INTO "unrelated_table" (id) VALUES('x');`,
].join("\n");

test("buildCalendarTablesRecoveryStatements extracts only the two calendar tables' own statements, in a safe drop/recreate order", () => {
  const statements = buildCalendarTablesRecoveryStatements(SAMPLE_BACKUP);

  // Nothing from "users" or "unrelated_table" leaked in.
  for (const statement of statements) {
    assert.doesNotMatch(statement, /\busers\b/, `must not include unrelated table statement: ${statement}`);
    assert.doesNotMatch(statement, /unrelated_table/, `must not include unrelated table statement: ${statement}`);
  }

  // Order: history dropped first (child, nothing references it), then
  // links (parent, now safe) -- then links recreated (schema, data,
  // indexes) before history, so history's own FK and inserts succeed
  // immediately against an already-stable parent.
  const kinds = statements.map((statement) => {
    if (/^DROP TABLE/i.test(statement)) return `drop:${/history/.test(statement) ? "history" : "links"}`;
    if (/^CREATE TABLE/i.test(statement)) return `create:${statement.includes(CALENDAR_EVENT_LINK_HISTORY_TABLE) ? "history" : "links"}`;
    if (/^INSERT/i.test(statement)) return `insert:${statement.includes(CALENDAR_EVENT_LINK_HISTORY_TABLE) ? "history" : "links"}`;
    if (/^CREATE.*INDEX/i.test(statement)) return `index:${statement.includes(CALENDAR_EVENT_LINK_HISTORY_TABLE) ? "history" : "links"}`;
    return `other:${statement}`;
  });

  assert.deepEqual(kinds, [
    "drop:history",
    "drop:links",
    "create:links",
    "insert:links",
    "insert:links",
    "index:links",
    "create:history",
    "insert:history",
    "index:history",
  ]);
});

test("buildCalendarTablesRecoveryStatements preserves each INSERT statement's own text exactly (minus the trailing semicolon)", () => {
  const statements = buildCalendarTablesRecoveryStatements(SAMPLE_BACKUP);
  assert.ok(statements.includes(`INSERT INTO "${CALENDAR_EVENT_LINKS_TABLE}" (id,sync_status) VALUES('link-1','pending')`));
  assert.ok(statements.includes(`INSERT INTO "${CALENDAR_EVENT_LINKS_TABLE}" (id,sync_status) VALUES('link-2','synced')`));
  assert.ok(statements.includes(`INSERT INTO "${CALENDAR_EVENT_LINK_HISTORY_TABLE}" (id,link_id) VALUES('hist-1','link-1')`));
});

test("buildCalendarTablesRecoveryStatements tolerates backtick-quoted identifiers too (this repo's own migration convention)", () => {
  const backtickBackup = SAMPLE_BACKUP.replaceAll('"', "`");
  const statements = buildCalendarTablesRecoveryStatements(backtickBackup);
  assert.ok(statements.some((s) => /^CREATE TABLE `calendar_event_links`/.test(s)));
  assert.ok(statements.some((s) => /^CREATE TABLE `calendar_event_link_history`/.test(s)));
});

test("buildCalendarTablesRecoveryStatements fails closed when calendar_event_links' own CREATE TABLE is missing from the backup", () => {
  const withoutLinks = SAMPLE_BACKUP.split("\n").filter((line) => !line.includes(`CREATE TABLE "${CALENDAR_EVENT_LINKS_TABLE}"`)).join("\n");
  assert.throws(() => buildCalendarTablesRecoveryStatements(withoutLinks), /no CREATE TABLE statement for "calendar_event_links"/);
});

test("buildCalendarTablesRecoveryStatements fails closed when calendar_event_link_history's own CREATE TABLE is missing from the backup", () => {
  const withoutHistory = SAMPLE_BACKUP.split("\n").filter((line) => !line.includes(`CREATE TABLE "${CALENDAR_EVENT_LINK_HISTORY_TABLE}"`)).join("\n");
  assert.throws(() => buildCalendarTablesRecoveryStatements(withoutHistory), /no CREATE TABLE statement for "calendar_event_link_history"/);
});

test("buildCalendarTablesRecoveryStatements never confuses calendar_event_links with calendar_event_link_history by name prefix", () => {
  const statements = buildCalendarTablesRecoveryStatements(SAMPLE_BACKUP);
  const linksInserts = statements.filter((s) => /^INSERT INTO ["`]?calendar_event_links["`]?\s*\(/i.test(s));
  assert.equal(linksInserts.length, 2, "only calendar_event_links' own two INSERTs must be classified under links, not calendar_event_link_history's");
});
