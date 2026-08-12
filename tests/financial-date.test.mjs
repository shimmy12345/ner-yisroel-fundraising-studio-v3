import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { financialDateLabel, normalizeFinancialDate, parseFinancialDate } from "../lib/financial-date.ts";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { buildUnifiedTimeline } from "../lib/relationships/unified-timeline.ts";

const augustFifth = Date.UTC(2026, 7, 5) / 1000;
assert.equal(parseFinancialDate("8/5/2026"), augustFifth);
assert.equal(parseFinancialDate("2026-08-05"), augustFifth);
assert.equal(parseFinancialDate("8/5/2026 12:00:00 AM"), augustFifth, "full JL exports may include a display-only midnight time");
assert.equal(parseFinancialDate("2026-08-05T00:00:00-07:00"), augustFifth, "an appended zone cannot shift the stored calendar date");
assert.equal(parseFinancialDate("2/29/2025"), null, "invalid leap dates are rejected instead of rolling forward");
assert.equal(normalizeFinancialDate(augustFifth + 16 * 3600), augustFifth);

for (const timezone of ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"]) {
  process.env.TZ = timezone;
  assert.equal(financialDateLabel(augustFifth), "Aug 5, 2026", `${timezone} must not shift a financial calendar date`);
}

const imported = await buildJlDonationPreview([{
  Code: "JL-FICTIONAL", Name: "Fictional Household", "Total Due": "25", "Item Num": "PAYMENT", Desc: "Pledge payment",
  Campaign: "ANNUAL", "Due Date": "8/5/2026", Amount: "25", Paid: "25", "Balance Due": "0", Company: "",
}], new Date("2026-08-05T12:00:00Z"));
assert.equal(imported.activities[0].activityDate, augustFifth);

const financial = { id: "gift-b", donor_id: "donor", external_source: "JL Solutions", activity_date: augustFifth + 12 * 3600, committed_cents: 2500, paid_cents: 2500, balance_cents: 0, item_type: "Gift", description: null, category: "completed_gift", workspace_status: "active", private_note: null, updated_at: 1 };
const timeline = buildUnifiedTimeline({
  giving: [{ ...financial, id: "gift-b" }, { ...financial, id: "gift-a" }],
  legacyGifts: [], payments: [],
  interactions: [{ id: "call", type: "call", occurred_at: augustFifth + 15 * 3600, summary: "Call", source: "capture-completed:test", created_at: augustFifth + 15 * 3600 }],
  reminders: [], now: augustFifth + 20 * 3600,
});
assert.equal(timeline.find((item) => item.key === "giving:gift-a").eventAt, augustFifth, "financial sorting uses the calendar day, not a hidden time");
assert.deepEqual(timeline.filter((item) => item.kind === "giving").map((item) => item.key), ["giving:gift-a", "giving:gift-b"], "same-day financial records use a stable id order");
assert.equal(timeline[0].key, "interaction:call", "true activity timestamps retain their actual chronological position");

const migration = await readFile(new URL("../drizzle/0020_financial_date_only.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE giving_activities(id TEXT PRIMARY KEY, activity_date INTEGER, paid_cents INTEGER, balance_cents INTEGER, donor_id TEXT); CREATE TABLE gifts(id TEXT PRIMARY KEY, received_at INTEGER, amount_cents INTEGER, donor_id TEXT); CREATE TABLE jl_payment_assignment_audits(id TEXT PRIMARY KEY, payment_date INTEGER, applied_cents INTEGER, pledge_activity_id TEXT);");
db.prepare("INSERT INTO giving_activities VALUES (?,?,?,?,?)").run("gift", augustFifth + 4 * 3600, 2500, 7500, "donor");
db.prepare("INSERT INTO gifts VALUES (?,?,?,?)").run("legacy", augustFifth + 8 * 3600, 1000, "donor");
db.prepare("INSERT INTO jl_payment_assignment_audits VALUES (?,?,?,?)").run("payment", augustFifth + 16 * 3600, 2500, "pledge");
db.exec(migration);
assert.deepEqual({ ...db.prepare("SELECT activity_date,paid_cents,balance_cents,donor_id FROM giving_activities").get() }, { activity_date: augustFifth, paid_cents: 2500, balance_cents: 7500, donor_id: "donor" });
assert.deepEqual({ ...db.prepare("SELECT received_at,amount_cents,donor_id FROM gifts").get() }, { received_at: augustFifth, amount_cents: 1000, donor_id: "donor" });
assert.deepEqual({ ...db.prepare("SELECT payment_date,applied_cents,pledge_activity_id FROM jl_payment_assignment_audits").get() }, { payment_date: augustFifth, applied_cents: 2500, pledge_activity_id: "pledge" });

const timelineComponent = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
assert.match(timelineComponent, /financialDateLabel\(item\.eventAt\)/);
// Calls, meetings, reminders, and scheduled work keep true date/time
// rendering by default -- eventDate() only drops to a bare date when the
// row is explicitly flagged occurred_at_date_only/due_at_date_only (a
// Monday.com import with no real time), never for a genuinely captured or
// scheduled interaction/reminder.
assert.match(timelineComponent, /const eventDate = \(epoch: number, timezone: string, dateOnlyFlag: number \| undefined\) => dateOnlyFlag \? dateOnly\(epoch, timezone\) : dateTime\(epoch, timezone\);/);
assert.match(timelineComponent, /eventDate\(item\.eventAt, timezone, item\.reminder\.due_at_date_only\)/);
assert.match(timelineComponent, /eventDate\(item\.eventAt, timezone, activity\.occurred_at_date_only\)/);
assert.doesNotMatch(timelineComponent, /kind === "payment"[^;]+dateTime\(/s, "payments never display a time");

process.stdout.write("Financial date-only checks passed.\n");
