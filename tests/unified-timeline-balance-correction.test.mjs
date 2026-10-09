import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { buildUnifiedTimeline } from "../lib/relationships/unified-timeline.ts";

// Donation History ("Unified Relationship Timeline") -- Manual Pledge
// Balance Corrections consistency (2026-10-09, see docs/AI-HANDOFF.md).
// Independent review found that a corrected pledge's effective balance
// ($0 for Kutoff's real DIN2023) was already correctly computed and
// displayed by Donation History (DONOR_GIVING_SQL's own COALESCE, fixed
// two rounds ago, applies to the SAME `giving` rows this component
// reads) -- but nothing distinguished a MANUALLY corrected $0 from an
// ordinarily, naturally fully-paid pledge, so a fundraiser scanning
// Donation History had no way to tell the two apart. This file verifies
// both halves: the data layer (balance_cents is already effective,
// confirmed real end to end) and the new "Corrected" indicator.

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

// ================================================================
// Pure data-layer proof: buildUnifiedTimeline passes `giving` rows
// through UNCHANGED (never recomputes balance_cents, never strips the
// field) -- so whatever effective balance the server query already
// computed is exactly what Donation History's own "giving" items carry.
// ================================================================

test("buildUnifiedTimeline passes each giving row's balance_cents through unchanged -- a pre-corrected ($0) row stays $0, an uncorrected row stays whatever it was", () => {
  const correctedRow = { id: "p-corrected", donor_id: "d1", external_source: "jl", activity_date: 1700000000, committed_cents: 500000, paid_cents: 479000, balance_cents: 0, item_type: null, description: null, source_campaign: "DIN2023", category: "partially_paid_pledge", workspace_status: "active", private_note: null, updated_at: 0 };
  const uncorrectedRow = { id: "p-uncorrected", donor_id: "d1", external_source: "jl", activity_date: 1700000000, committed_cents: 300000, paid_cents: 275000, balance_cents: 25000, item_type: null, description: null, source_campaign: "DIN2025", category: "partially_paid_pledge", workspace_status: "active", private_note: null, updated_at: 0 };
  const timeline = buildUnifiedTimeline({ giving: [correctedRow, uncorrectedRow], legacyGifts: [], payments: [], interactions: [], reminders: [], now: 1800000000 });
  const corrected = timeline.find((item) => item.kind === "giving" && item.giving.id === "p-corrected");
  const uncorrected = timeline.find((item) => item.kind === "giving" && item.giving.id === "p-uncorrected");
  assert.equal(corrected.giving.balance_cents, 0, "requirement 2/3: Donation History's own data must reflect the effective (corrected) balance, not the raw imported one");
  assert.equal(uncorrected.giving.balance_cents, 25000, "an uncorrected pledge ($250) is completely unaffected by an unrelated correction");
});

// ================================================================
// Component-source proof: the "Corrected" indicator is wired correctly
// (requirement 4), the displayed balance is never recomputed client-side
// (requirement 2), and page.tsx builds/passes the active-corrections map
// correctly scoped to pledge id (requirement 6/consistency).
// ================================================================

test("UnifiedRelationshipTimeline reads activity.balance_cents directly (never recomputes it) and renders a 'Corrected' badge with a tooltip only when an active correction exists for that exact pledge", async () => {
  const component = await read("app/donors/[id]/UnifiedRelationshipTimeline.tsx");
  assert.match(component, /const correction = corrections\[activity\.id\];/, "the correction lookup must be keyed on the exact pledge id, never donor-wide");
  assert.match(component, /correction && <span className="timeline-corrected-badge" title=\{`Originally \$\{money\(correction\.importedBalanceCentsAtCorrection\)\} outstanding per the imported JL record; manually corrected to \$\{money\(correction\.correctedBalanceCents\)\}\.`\}>Corrected<\/span>/, "the badge must carry a tooltip naming both the original imported figure and the corrected figure");
  assert.match(component, /correction \? ` · \$\{money\(activity\.balance_cents \?\? 0\)\} outstanding` :/, "a corrected pledge must EXPLICITLY show its (possibly $0) outstanding amount -- never silently fall back to the same blank state an ordinarily fully-paid pledge already uses");
  // Never a second, divergent balance computation -- activity.balance_cents
  // (already effective, from the server query) is the only value read;
  // `correction.correctedBalanceCents`/`importedBalanceCentsAtCorrection`
  // are used ONLY inside the tooltip text, never assigned into the
  // displayed balance itself.
  assert.doesNotMatch(component, /correction\.correctedBalanceCents\} outstanding/, "the displayed balance must come from activity.balance_cents, never directly from the correction row");
});

test("the donor page builds the active-corrections lookup scoped to EXACTLY one entry per pledge (the active/unreversed row only) and passes it to Donation History", async () => {
  const page = await read("app/donors/[id]/page.tsx");
  assert.match(page, /const active = history\.find\(\(c\) => c\.reversed_at === null\);/, "only the active (unreversed) correction may ever appear in this lookup -- a reversed one must never still show the badge");
  assert.match(page, /if \(active\) activeCorrectionsByPledgeId\[pledgeId\] = \{ correctedBalanceCents: active\.corrected_balance_cents, importedBalanceCentsAtCorrection: active\.imported_balance_cents_at_correction \};/);
  assert.match(page, /corrections=\{activeCorrectionsByPledgeId\}/, "Donation History must actually receive this prop -- building the map alone is not enough");
});

// ================================================================
// Real, isolated end-to-end proof: the exact Kutoff two-pledge shape,
// using the real DONOR_GIVING_SQL query text (mirrored, not
// reimplemented) plus the real correction-history query, confirming
// everything requirement 7 asks for in one real database.
// ================================================================

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}
const NOW = Math.floor(Date.parse("2026-10-09T14:00:00Z") / 1000);
const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

function seedUser(db, userId = "u1") { db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW); }
function seedDonor(db, { id, displayName, donorCode, userId = "u1" }) { db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, donor_code, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?, ?)").run(id, userId, displayName, donorCode, NOW, NOW); }
function seedPledge(db, { id, donorId, committedCents, paidCents, balanceCents, sourceCampaign, userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, committed_cents, paid_cents, balance_cents, category, source_campaign, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, ?, ?, ?, 'partially_paid_pledge', ?, 'live', 'active', '{}', ?, ?)`).run(id, donorId, userId, id, committedCents, paidCents, balanceCents, sourceCampaign, NOW, NOW);
}
function seedPlan(db, { id, donorId, pledgeActivityId, userId = "u1" }) {
  db.prepare(`INSERT INTO pledge_payment_plans (id, user_id, donor_id, pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at, original_pledge_date, commitment_duration_months, created_at, updated_at)
    VALUES (?, ?, ?, ?, 25000, 18, ?, ?, ?, 12, ?, ?)`).run(id, userId, donorId, pledgeActivityId, utcMidnight(2026, 10, 18), utcMidnight(2026, 10, 18), utcMidnight(2025, 11, 18), NOW, NOW);
}
// Mirrors lib/relationships/giving.ts's DONOR_GIVING_SQL verbatim --
// the exact query Donation History's own `giving` prop is built from.
function queryDonorGiving(db, donorId, userId = "u1") {
  return db.prepare(`SELECT ga.id, ga.donor_id, ga.external_source, ga.activity_date, ga.committed_cents, ga.paid_cents, COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents, ga.item_type, ga.description, ga.source_campaign, ga.category, ga.workspace_status, ga.private_note, ga.confirmed_by_activity_id, ga.updated_at
    FROM giving_activities ga
    LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
    WHERE ga.donor_id = ? AND ga.owner_user_id = ? AND ga.record_origin = 'live'
    ORDER BY ga.activity_date DESC LIMIT 500`).all(donorId, userId);
}
function activeCorrectionsByPledge(db, donorId, userId = "u1") {
  const rows = db.prepare(`SELECT pledge_activity_id, corrected_balance_cents, imported_balance_cents_at_correction FROM pledge_balance_corrections WHERE donor_id = ? AND user_id = ? AND reversed_at IS NULL`).all(donorId, userId);
  return Object.fromEntries(rows.map((r) => [r.pledge_activity_id, { correctedBalanceCents: r.corrected_balance_cents, importedBalanceCentsAtCorrection: r.imported_balance_cents_at_correction }]));
}
function applyCorrection(db, { pledgeActivityId, donorId, correctedBalanceCents, reason, userId = "u1", now = NOW }) {
  const pledge = db.prepare("SELECT balance_cents FROM giving_activities WHERE id = ?").get(pledgeActivityId);
  db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(crypto.randomUUID(), userId, donorId, pledgeActivityId, pledge.balance_cents, correctedBalanceCents, reason, now);
}

test("end-to-end: DIN2023 corrected to $0 (no plan) and DIN2025 at $250 (active plan) -- Donation History's own giving rows and the active-corrections map are both exactly right", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "donor-1", displayName: "Rabbi & Mrs. Shlomo Kutoff", donorCode: "57932" });
  seedPledge(db, { id: "din2023", donorId: "donor-1", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  seedPledge(db, { id: "din2025", donorId: "donor-1", committedCents: 300000, paidCents: 275000, balanceCents: 25000, sourceCampaign: "DIN2025" });
  seedPlan(db, { id: "din2025-plan", donorId: "donor-1", pledgeActivityId: "din2025" });

  const correctionId = crypto.randomUUID();
  db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
    VALUES (?, 'u1', 'donor-1', 'din2023', 21000, 0, 'JL mistake', ?, NULL, NULL)`).run(correctionId, NOW);

  const rows = queryDonorGiving(db, "donor-1");
  const din2023Row = rows.find((r) => r.id === "din2023");
  const din2025Row = rows.find((r) => r.id === "din2025");

  // Corrected pledge: Donation History's own query already reports $0.
  assert.equal(din2023Row.balance_cents, 0, "DIN2023 must display $0 outstanding in Donation History");
  // Uncorrected pledge, same donor: completely unaffected.
  assert.equal(din2025Row.balance_cents, 25000, "DIN2025 must continue displaying $250 outstanding");
  assert.equal(din2025Row.paid_cents, 275000);
  assert.equal(din2025Row.committed_cents, 300000);

  // DIN2025's payment plan is untouched.
  const planAfter = db.prepare("SELECT * FROM pledge_payment_plans WHERE id = 'din2025-plan'").get();
  assert.equal(planAfter.ended_at, null, "DIN2025's active payment plan must remain unchanged");

  // The active-corrections lookup Donation History's badge depends on:
  // exactly one entry, for DIN2023 only.
  const corrections = activeCorrectionsByPledge(db, "donor-1");
  assert.deepEqual(Object.keys(corrections), ["din2023"]);
  assert.equal(corrections.din2023.correctedBalanceCents, 0);
  assert.equal(corrections.din2023.importedBalanceCentsAtCorrection, 21000);
  assert.equal(corrections.din2025, undefined, "DIN2025 must never appear in this map -- no 'Corrected' badge may ever show on it");

  // No fictitious payment, no inflated totals, raw imported values
  // preserved on the corrected pledge too.
  assert.equal(db.prepare("SELECT COUNT(*) AS cnt FROM jl_payment_assignment_audits").get().cnt, 0);
  const din2023Raw = db.prepare("SELECT committed_cents, paid_cents, balance_cents FROM giving_activities WHERE id = 'din2023'").get();
  assert.equal(din2023Raw.committed_cents, 500000);
  assert.equal(din2023Raw.paid_cents, 479000);
  assert.equal(din2023Raw.balance_cents, 21000, "the raw imported balance column itself is never overwritten, even though Donation History displays the effective $0");
});

test("end-to-end: reversing the DIN2023 correction restores the imported $210 in Donation History and removes it from the active-corrections map", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "donor-2", displayName: "Fixture Donor", donorCode: "90001" });
  seedPledge(db, { id: "p-rev", donorId: "donor-2", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  applyCorrection(db, { pledgeActivityId: "p-rev", donorId: "donor-2", correctedBalanceCents: 0, reason: "JL mistake" });

  assert.equal(queryDonorGiving(db, "donor-2").find((r) => r.id === "p-rev").balance_cents, 0, "sanity check: corrected to $0 first");
  assert.ok(activeCorrectionsByPledge(db, "donor-2")["p-rev"]);

  const correction = db.prepare("SELECT id FROM pledge_balance_corrections WHERE pledge_activity_id = 'p-rev' AND reversed_at IS NULL").get();
  db.prepare("UPDATE pledge_balance_corrections SET reversed_at = ?, reversal_reason = ? WHERE id = ?").run(NOW + 60, "Applied in error", correction.id);

  const afterReversal = queryDonorGiving(db, "donor-2").find((r) => r.id === "p-rev");
  assert.equal(afterReversal.balance_cents, 21000, "Donation History must show the imported $210 again once the correction is reversed");
  assert.equal(activeCorrectionsByPledge(db, "donor-2")["p-rev"], undefined, "the reversed correction must no longer appear in the active-corrections map -- no 'Corrected' badge after reversal");

  // The historical row itself is preserved (never deleted), just no
  // longer active.
  const history = db.prepare("SELECT * FROM pledge_balance_corrections WHERE pledge_activity_id = 'p-rev'").all();
  assert.equal(history.length, 1);
  assert.notEqual(history[0].reversed_at, null);
});
