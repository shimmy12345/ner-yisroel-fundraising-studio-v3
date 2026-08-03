import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeCsv, parseCsv, rowsToRecords } from "../lib/import/file-parsers.ts";
import { buildJlDonationPreview, calculateGivingSnapshot, classifyJlDonation, isJlDonationExport, JL_DONATION_COLUMNS } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";
import { chunkJsonRows, D1_JSON_CHUNK_BYTES } from "../lib/import/d1-json-chunks.ts";

const base = { Code: "JL-900", Name: "Fictional Family", "Total Due": "100", "Item Num": "GIFT", Desc: "Education support", Campaign: "ANNUAL", "Due Date": "2025-06-15", Amount: "100.00", Paid: "100.00", "Balance Due": "0", Company: "" };

async function run() {
  assert.equal(isJlDonationExport([...JL_DONATION_COLUMNS]), true);
  assert.equal(classifyJlDonation(base).category, "completed_gift");
  assert.equal(classifyJlDonation({ ...base, Paid: "0", "Balance Due": "100" }).category, "open_pledge");
  assert.equal(classifyJlDonation({ ...base, Paid: "40", "Balance Due": "60" }).category, "partially_paid_pledge");
  assert.equal(classifyJlDonation({ ...base, "Item Num": "DINNER", Desc: "Half page dinner ad" }).category, "event_or_ad");
  assert.equal(classifyJlDonation({ ...base, Amount: "0", Paid: "0", "Balance Due": "0", Desc: "Complimentary reservation" }).category, "nonfinancial_entry");
  assert.equal(classifyJlDonation({ ...base, Paid: "70", "Balance Due": "50" }).category, "needs_review");
  assert.equal(classifyJlDonation({ ...base, Code: "" }).category, "needs_review");
  assert.equal(classifyJlDonation({ ...base, "Due Date": "1902-01-01" }).suspiciousDate, true);

  const windowsText = decodeCsv(Uint8Array.from([0x44,0x65,0x73,0x63,0x0a,0x93,0x47,0x69,0x66,0x74,0x94]).buffer);
  assert.equal(windowsText, "Desc\n“Gift”");

  const preview = await buildJlDonationPreview([base, { ...base }, { ...base, Code: "JL-901", Paid: "0", "Balance Due": "100" }], new Date("2026-07-31"));
  assert.equal(preview.duplicateRows.length, 1);
  assert.equal(preview.counts.completed_gift, 1);
  assert.equal(preview.counts.open_pledge, 1);

  const changedPayment = await buildJlDonationPreview([{ ...base, Paid: "40", "Balance Due": "60", "Total Due": "999" }], new Date("2026-07-31"));
  assert.equal(changedPayment.activities[0].fingerprint, preview.activities[0].fingerprint, "payment/balance and invoice total must not change the stable activity fingerprint");
  const matched = matchJlDonationActivities(changedPayment, [{ id: "imported-code-jl-900", external_id: "JL-900" }], [{ source_fingerprint: changedPayment.activities[0].fingerprint, paid_cents: 0, balance_cents: 10000, category: "open_pledge", source_snapshot: "{}" }]);
  assert.equal(matched.proposedUpdates.length, 1);
  assert.equal(matched.newActivities.length, 0);
  const unknown = matchJlDonationActivities(preview, [], []);
  assert.equal(unknown.unknownHousehold, 2);

  const snapshot = calculateGivingSnapshot([preview.activities[0], changedPayment.activities[0]], new Date("2026-07-31"));
  assert.equal(snapshot.lifetimePaidCents, 14000);
  assert.equal(snapshot.outstandingCents, 6000);
  assert.equal(snapshot.typicalPaidCents, 7000);

  const csv = rowsToRecords(parseCsv(`${JL_DONATION_COLUMNS.join(",")}\nJL-1,Example,100,GIFT,Scholarship,ANNUAL,2025-01-01,100,100,0,\n`));
  assert.equal(isJlDonationExport(csv.columns), true);

  const compactCsv = rowsToRecords(parseCsv(`Code,First Name,Last Name,Date,Campaign,Amount
JL-101,Example,One,8/3/2026,ANNUAL,$150.00
JL-102,Example,Two,8/3/2026,ANNUAL,$18.00
JL-103,Example,Three,8/2/2026,SPECIAL,"$1,000.00 "
JL-104,Example,Four,8/3/2026,ANNUAL,$36.00
JL-105,Example,Five,8/3/2026,SPECIAL,$72.00
JL-106,Example,Six,8/3/2026,ANNUAL,$100.00
`));
  assert.equal(isJlDonationExport(compactCsv.columns), true, "the six-column incremental JL donation shape must not fall through to the household importer");
  const compactPreview = await buildJlDonationPreview(compactCsv.rows, new Date("2026-08-03"));
  assert.equal(compactPreview.activities.length, 6);
  assert.equal(compactPreview.counts.needs_review, 6);
  assert.ok(compactPreview.activities.every((activity) => activity.reviewReason === "Payment status cannot be determined because Paid and Balance Due columns are missing"));
  const compactMatch = matchJlDonationActivities(compactPreview, compactPreview.activities.map((activity, index) => ({ id: `donor-${index}`, external_id: activity.externalHouseholdId })), []);
  assert.equal(compactMatch.matched.length, 0);
  assert.equal(compactMatch.reviewActivities.length, 6);
  const approvedCompactPreview = await buildJlDonationPreview(compactCsv.rows, new Date("2026-08-03"), { compactPaymentStatus: "fully_paid" });
  assert.equal(approvedCompactPreview.counts.completed_gift, 6);
  assert.ok(approvedCompactPreview.activities.every((activity) => activity.paidCents === activity.committedCents && activity.balanceCents === 0));

  const productionShape = Array.from({ length: 6275 }, (_, index) => ({
    id: `jl-giving-${"a".repeat(64)}`, donorId: `imported-code-jl-${index % 248}`, externalHouseholdId: `JL-${index % 248}`,
    fingerprint: "a".repeat(64), activityDate: 1750000000, committedCents: 10000, paidCents: 10000, balanceCents: 0,
    itemType: "GIFT", description: "Annual education support", sourceCampaign: "ANNUAL", category: "completed_gift",
    sourceSnapshot: JSON.stringify(base), now: 1750000000,
  }));
  assert.ok(new TextEncoder().encode(JSON.stringify(productionShape)).byteLength > 2_000_000, "the original single binding exceeds D1's 2 MB string limit for the JL export size");
  const chunks = chunkJsonRows(productionShape);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flatMap((chunk) => JSON.parse(chunk)).length, productionShape.length);
  assert.ok(chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= D1_JSON_CHUNK_BYTES));

  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const rollbackRoute = await readFile(new URL("../app/api/import/rollback/route.ts", import.meta.url), "utf8");
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
  assert.match(previewRoute, /getChatGPTUser\(\)/);
  assert.match(importRoute, /getChatGPTUser\(\)/);
  assert.match(rollbackRoute, /getChatGPTUser\(\)/);
  assert.match(importRoute, /await env\.DB\.batch\(statements\)/);
  assert.match(importRoute, /chunkJsonRows\(activityRows\)/);
  assert.match(rollbackRoute, /await env\.DB\.batch\(statements\)/);
  assert.match(importRoute, /ON CONFLICT\(owner_user_id, external_source, source_fingerprint\) DO UPDATE/);
  assert.match(importRoute, /rollbackCauses/);
  assert.match(importRoute, /passedRows/);
  assert.match(importRoute, /failedRows/);
  assert.match(importRoute, /transaction_database_errors/);
  assert.match(importRoute, /unexpected_exceptions/);
  assert.match(importRoute, /No rows were imported because every row requires review\./);
  assert.match(importRoute, /allRowsRequireReview/);
  assert.match(importRoute, /reviewRows/);
  assert.doesNotMatch(importRoute, /relationship_summary\s*=|institutional_memory\s*=|DELETE FROM interactions/i);
  assert.match(donorPage, /Lifetime paid/);
  assert.match(donorPage, /Open commitments/);
  assert.match(importExperience, /No changes were made to the database\./);
  assert.match(importExperience, /Download rejected rows CSV/);
  assert.match(importExperience, /Download validation report/);
  assert.match(importExperience, /Download review report CSV/);
  assert.match(importExperience, /Correct the column setup or source classifications, then retry\./);
  assert.match(importExperience, /MANUAL PAYMENT ASSIGNMENT/);
  assert.match(importExperience, /households matched/);
  assert.match(importExperience, /elapsed import time/);
  process.stdout.write("JL donation import checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
