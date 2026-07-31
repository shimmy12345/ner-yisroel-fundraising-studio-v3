import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeCsv, parseCsv, rowsToRecords } from "../lib/import/file-parsers.ts";
import { buildJlDonationPreview, calculateGivingSnapshot, classifyJlDonation, isJlDonationExport, JL_DONATION_COLUMNS } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";

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

  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const rollbackRoute = await readFile(new URL("../app/api/import/rollback/route.ts", import.meta.url), "utf8");
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(previewRoute, /getChatGPTUser\(\)/);
  assert.match(importRoute, /getChatGPTUser\(\)/);
  assert.match(rollbackRoute, /getChatGPTUser\(\)/);
  assert.match(importRoute, /await env\.DB\.batch\(statements\)/);
  assert.match(rollbackRoute, /await env\.DB\.batch\(statements\)/);
  assert.match(importRoute, /ON CONFLICT\(external_source, source_fingerprint\) DO UPDATE/);
  assert.doesNotMatch(importRoute, /relationship_summary\s*=|institutional_memory\s*=|DELETE FROM interactions/i);
  assert.match(donorPage, /Lifetime paid/);
  assert.match(donorPage, /Open commitments/);
  process.stdout.write("JL donation import checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
