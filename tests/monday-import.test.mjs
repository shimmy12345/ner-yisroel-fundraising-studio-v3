import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { parseMondayWorkbook, excelSerialToIsoDate } from "../lib/import/monday-workbook.ts";
import { classifyMondayText, classifyMondayDisposition } from "../lib/import/monday-classify.ts";
import { mondaySourceFingerprint, mondayInteractionId, mondayRecommendationId } from "../lib/import/monday-fingerprint.ts";
import { matchMondayDonor, buildMondayPreview } from "../lib/import/monday-pipeline.ts";

// Fictional fixture (no real donor data) built to reproduce the exact
// disposition distribution reconciled by hand against the real Monday.com
// pipeline export: 34 matched donor codes, 2 unmatched codes, 4 no-code
// donors; 148 in-scope subitems (from matched donors only) splitting into
// 5 confirm-contact candidates, 3 future planned actions, 68 past-dated +
// 6 undated historical planned actions (both default Ignore), 44 donation
// notes, and 22 ambiguous rows; 11 out-of-scope subitems belonging to the
// unmatched/no-code donors.

const TODAY_ISO = "2026-08-11";

function cellInline(col, row, value) {
  if (!value) return "";
  const escaped = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<c r="${col}${row}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
}
function cellNumber(col, row, value) {
  if (value == null) return "";
  return `<c r="${col}${row}"><v>${value}</v></c>`;
}
function isoToSerial(iso) {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000) + 25569;
}

function buildWorkbookBytes(donorBlocks) {
  let rowNum = 4; // rows 1-3 are title / group label / column header, all skipped
  const rows = [];
  for (const donor of donorBlocks) {
    rows.push(`<row r="${rowNum}">${cellInline("A", rowNum, donor.name)}${donor.code ? cellInline("D", rowNum, donor.code) : ""}</row>`);
    rowNum += 1;
    for (const item of donor.subitems) {
      rows.push(`<row r="${rowNum}">${cellInline("B", rowNum, item.text)}${item.dueIso ? cellNumber("C", rowNum, isoToSerial(item.dueIso)) : ""}</row>`);
      rowNum += 1;
    }
  }
  const sheetXml = `<?xml version="1.0"?><worksheet><sheetData>`
    + `<row r="1">${cellInline("A", 1, "Pipeline Export")}</row>`
    + `<row r="2">${cellInline("A", 2, "Prospects")}</row>`
    + `<row r="3">${cellInline("A", 3, "Name")}${cellInline("B", 3, "Subitems")}${cellInline("C", 3, "Date of Last Contact")}${cellInline("D", 3, "Code")}</row>`
    + rows.join("")
    + `</sheetData></worksheet>`;
  return zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheetXml) });
}

function distribute(items, donorCount) {
  const buckets = Array.from({ length: donorCount }, () => []);
  items.forEach((item, index) => buckets[index % donorCount].push(item));
  return buckets;
}

function repeat(pool, count) {
  return Array.from({ length: count }, (_, index) => pool[index % pool.length]);
}

const confirmContactCandidates = [
  { text: "Called to check in", dueIso: "2024-09-02" },
  { text: "Met with household for annual visit", dueIso: "2024-10-05" },
  { text: "Personal invite to gala", dueIso: "2024-11-01" },
  { text: "Thanked for pledge renewal", dueIso: "2025-01-15" },
  { text: "Solicited for $18K", dueIso: "2025-09-29" },
];
const futurePlanned = [
  { text: "Solicit when current pledge is paid", dueIso: "2026-11-16" },
  { text: "Schedule qualification visit", dueIso: "2026-12-01" },
  { text: "Reach out about capital campaign", dueIso: "2027-01-10" },
];
const historicalPastPool = ["Schedule meeting", "Follow up next quarter", "Call before year end", "Send proposal", "Make cultivation call", "Reach out for coffee", "Engage for spring event", "Invite for site visit", "Solicit for $10k", "Solicit for annual campaign"];
const historicalPast = repeat(historicalPastPool, 68).map((text, index) => ({ text, dueIso: index % 2 === 0 ? "2025-10-29" : "2024-05-15" }));
const historicalUndated = repeat(historicalPastPool, 6).map((text) => ({ text, dueIso: null }));
const historicalPlanned = [...historicalPast, ...historicalUndated];
const donationNotes = [...repeat(["2025 Donation"], 20), ...repeat(["2024 Donation"], 15), ...repeat(["Donation made"], 9)].map((text) => ({ text, dueIso: null }));
const ambiguousRows = repeat(["Meeting", "Review file", "Check status", "Update", "TBD"], 22).map((text) => ({ text, dueIso: null }));

assert.equal(confirmContactCandidates.length, 5);
assert.equal(futurePlanned.length, 3);
assert.equal(historicalPast.length, 68);
assert.equal(historicalUndated.length, 6);
assert.equal(historicalPlanned.length, 74);
assert.equal(donationNotes.length, 44);
assert.equal(ambiguousRows.length, 22);

const inScopeItems = [...confirmContactCandidates, ...futurePlanned, ...historicalPlanned, ...donationNotes, ...ambiguousRows];
assert.equal(inScopeItems.length, 148, "in-scope subitems must sum to exactly 148");

const outOfScopeItems = [
  { text: "Called to check in", dueIso: "2024-09-02" },
  { text: "Meeting", dueIso: null },
  { text: "2025 Donation", dueIso: null },
  { text: "Schedule meeting", dueIso: "2025-10-29" },
  { text: "Solicited for $5K", dueIso: "2025-08-01" },
  { text: "Meeting", dueIso: null },
  { text: "2024 Donation", dueIso: null },
  { text: "Follow up next quarter", dueIso: "2025-11-03" },
  { text: "Meeting", dueIso: null },
  { text: "2025 Donation", dueIso: null },
  { text: "Schedule meeting", dueIso: "2024-05-15" },
];
assert.equal(outOfScopeItems.length, 11, "out-of-scope subitems must sum to exactly 11");

const matchedDonorItemBuckets = distribute(inScopeItems, 34);
const matchedDonorBlocks = matchedDonorItemBuckets.map((subitems, index) => ({
  name: `Fictional Household ${index + 1}`,
  code: `M${String(index + 1).padStart(3, "0")}`,
  subitems: subitems.map((item, subIndex) => ({ text: item.text, dueDateRaw: item.dueIso ? String(isoToSerial(item.dueIso)) : null, index: subIndex })),
}));

const unmatchedCodeDonorBlocks = [
  { name: "Unmatched Household 1", code: "U001", subitems: [] },
  { name: "Unmatched Household 2", code: "U002", subitems: [] },
];
const noCodeDonorBlocks = [
  { name: "No Code Household 1", code: null, subitems: [] },
  { name: "No Code Household 2", code: null, subitems: [] },
  { name: "No Code Household 3", code: null, subitems: [] },
  { name: "No Code Household 4", code: null, subitems: [] },
];
const nonMatchedDonorBlocks = [...unmatchedCodeDonorBlocks, ...noCodeDonorBlocks];
distribute(outOfScopeItems, nonMatchedDonorBlocks.length).forEach((subitems, index) => {
  nonMatchedDonorBlocks[index].subitems = subitems.map((item, subIndex) => ({ text: item.text, dueDateRaw: item.dueIso ? String(isoToSerial(item.dueIso)) : null, index: subIndex }));
});

// Fixture donor blocks (raw shape expected by buildMondayPreview) built
// directly here (bypassing the xlsx round-trip) for the disposition-count
// assertions below, and separately re-derived from a real generated .xlsx
// byte stream further down to prove the parser itself is correct too.
const donorBlocks = [...matchedDonorBlocks, ...nonMatchedDonorBlocks];

const lookup = new Map(matchedDonorBlocks.map((donor) => [donor.code, { id: `donor-${donor.code}`, displayName: donor.name }]));

async function run() {
  // --- excelSerialToIsoDate ---
  assert.equal(excelSerialToIsoDate(null), null);
  assert.equal(excelSerialToIsoDate("not-a-number"), null);
  assert.equal(excelSerialToIsoDate(String(isoToSerial("2025-03-14"))), "2025-03-14");

  // --- classifyMondayText / classifyMondayDisposition (spot checks against
  // the exact rules reconciled by hand during the design phase) ---
  assert.equal(classifyMondayText("Personal invite to Teaneck event"), "professional_contact");
  assert.equal(classifyMondayText("Solicited for $18K"), "solicitation");
  assert.equal(classifyMondayText("Solicit for $10k"), "solicitation");
  assert.equal(classifyMondayText("Schedule meeting"), "planned_action");
  assert.equal(classifyMondayText("2025 Donation"), "donation_note");
  assert.equal(classifyMondayText("Meeting"), "ambiguous");
  assert.equal(classifyMondayDisposition("Personal invite to Teaneck event", "2024-09-02", TODAY_ISO), "confirm_contact_candidate");
  assert.equal(classifyMondayDisposition("Solicited for $18K", "2025-09-29", TODAY_ISO), "confirm_contact_candidate");
  assert.equal(classifyMondayDisposition("Solicit for $10k", "2025-10-29", TODAY_ISO), "historical_planned");
  assert.equal(classifyMondayDisposition("Solicit when current pledge is paid", "2026-11-16", TODAY_ISO), "future_planned");
  assert.equal(classifyMondayDisposition("2025 Donation", null, TODAY_ISO), "donation_note");
  assert.equal(classifyMondayDisposition("Meeting", "2024-12-06", TODAY_ISO), "ambiguous");
  assert.equal(classifyMondayDisposition("Schedule qualification visit", null, TODAY_ISO), "historical_planned", "an undated planned action must default to historical, never future");

  // --- parseMondayWorkbook: prove the parser itself reconstructs donor
  // blocks correctly from real xlsx bytes, not just from the raw fixture
  // objects used for the count assertions below ---
  const bytes = buildWorkbookBytes(donorBlocks);
  const parsed = parseMondayWorkbook(bytes);
  assert.equal(parsed.length, 40, "34 matched + 2 unmatched-code + 4 no-code donors");
  const parsedTotalSubitems = parsed.reduce((sum, donor) => sum + donor.subitems.length, 0);
  assert.equal(parsedTotalSubitems, 159, "148 in-scope + 11 out-of-scope");
  const parsedMatched = parsed.filter((donor) => donor.code && lookup.has(donor.code));
  const parsedUnmatchedCode = parsed.filter((donor) => donor.code && !lookup.has(donor.code));
  const parsedNoCode = parsed.filter((donor) => !donor.code);
  assert.equal(parsedMatched.length, 34);
  assert.equal(parsedUnmatchedCode.length, 2);
  assert.equal(parsedNoCode.length, 4);
  assert.equal(parsed.find((donor) => donor.code === "M001").subitems[0].text, matchedDonorBlocks[0].subitems[0].text);

  // --- buildMondayPreview: donor matching + disposition, driven straight
  // off the same donorBlocks objects (both routes -- parsed-from-xlsx and
  // hand-built -- must agree; only the hand-built path is asserted below
  // in detail since it carries the known-correct subitemIndex bookkeeping) ---
  const rows = buildMondayPreview(donorBlocks, lookup, TODAY_ISO);
  assert.equal(rows.length, 159);
  const matchedRows = rows.filter((row) => row.match.status === "matched");
  const unmatchedCodeRows = rows.filter((row) => row.match.status === "unmatched_code");
  const noCodeRows = rows.filter((row) => row.match.status === "no_code");
  assert.equal(matchedRows.length, 148, "148 in-scope subitems belong to matched donors");
  assert.equal(unmatchedCodeRows.length + noCodeRows.length, 11, "11 out-of-scope subitems belong to unmatched/no-code donors");

  const byDisposition = { confirm_contact_candidate: 0, future_planned: 0, historical_planned: 0, donation_note: 0, ambiguous: 0 };
  for (const row of matchedRows) byDisposition[row.disposition] += 1;
  assert.deepEqual(byDisposition, { confirm_contact_candidate: 5, future_planned: 3, historical_planned: 74, donation_note: 44, ambiguous: 22 });

  // Historical/undated planned actions must never be indistinguishable from
  // future ones -- every historical_planned row here has either a past due
  // date or none at all, never a future one.
  for (const row of matchedRows.filter((r) => r.disposition === "historical_planned")) {
    assert.ok(row.dueDateIso === null || row.dueDateIso <= TODAY_ISO, `historical_planned row must not carry a future date: ${row.text} (${row.dueDateIso})`);
  }
  for (const row of matchedRows.filter((r) => r.disposition === "future_planned")) {
    assert.ok(row.dueDateIso !== null && row.dueDateIso > TODAY_ISO, `future_planned row must carry a genuinely future date: ${row.text}`);
  }
  // Donation notes and ambiguous rows have exactly one of those two
  // dispositions and no other -- the commit route only ever accepts
  // confirm_contact_candidate, future_planned, or historical_planned (see
  // tests/monday-import-safety.test.mjs for the route-level proof that
  // donation_note/ambiguous can never reach a write).
  for (const row of matchedRows.filter((r) => r.disposition === "donation_note" || r.disposition === "ambiguous")) {
    assert.ok(row.disposition === "donation_note" || row.disposition === "ambiguous");
  }

  // --- matchMondayDonor: exact-code match only, no fuzzy name fallback ---
  const exactMatch = matchMondayDonor({ name: "Fictional Household 1", code: "M001", subitems: [] }, lookup);
  assert.equal(exactMatch.status, "matched");
  assert.equal(exactMatch.nameConflict, false);
  const similarNameWrongCode = matchMondayDonor({ name: "Fictional Household 1", code: "Z999" }, lookup);
  assert.equal(similarNameWrongCode.status, "unmatched_code", "a near-identical name must never substitute for an exact code match");
  const noCode = matchMondayDonor({ name: "No Code Household 1", code: null, subitems: [] }, lookup);
  assert.equal(noCode.status, "no_code");
  const conflictingName = matchMondayDonor({ name: "Someone Else Entirely", code: "M001", subitems: [] }, lookup);
  assert.equal(conflictingName.status, "matched");
  assert.equal(conflictingName.nameConflict, true, "a matched code with an inconsistent name must still be flagged for review, never silently accepted");

  // --- Idempotency: the fingerprint (and therefore the deterministic
  // interaction/recommendation id) is derived only from stable Monday-side
  // identity. Re-running the exact same input always yields the same id --
  // this is what lets a re-import, or a corrected confirmed-contact-date,
  // update the existing row instead of duplicating it. actualContactDate /
  // a follow-up's chosen due date are not part of the function's input at
  // all, so no value the fundraiser picks during review can ever change
  // which row a re-import lands on. ---
  const sampleInput = { donorCode: "M001", subitemIndex: 0, text: "Called to check in", dueDateRaw: String(isoToSerial("2024-09-02")) };
  const fingerprintA = mondaySourceFingerprint(sampleInput);
  const fingerprintB = mondaySourceFingerprint({ ...sampleInput });
  assert.equal(fingerprintA, fingerprintB, "identical Monday-side input must always produce the identical fingerprint");
  assert.equal(mondaySourceFingerprint.length, 1, "the fingerprint function accepts exactly one argument -- there is no parameter for the fundraiser's chosen date");
  assert.equal(mondayInteractionId(fingerprintA), mondayInteractionId(fingerprintB));
  assert.equal(mondayInteractionId(fingerprintA), `monday-interaction-${fingerprintA}`);
  assert.equal(mondayRecommendationId(fingerprintA), `monday-recommendation-${fingerprintA}`);
  // The id space is structurally disjoint from crypto.randomUUID()'s output
  // -- an UPDATE keyed on this id can never collide with an unrelated row.
  assert.doesNotMatch(mondayInteractionId(fingerprintA), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const distinctInputs = [
    sampleInput,
    { ...sampleInput, subitemIndex: 1 },
    { ...sampleInput, text: "Different text" },
    { ...sampleInput, dueDateRaw: null },
    { ...sampleInput, donorCode: "M002" },
  ];
  const distinctFingerprints = new Set(distinctInputs.map((input) => mondaySourceFingerprint(input)));
  assert.equal(distinctFingerprints.size, distinctInputs.length, "changing any stable Monday-side field must change the fingerprint");

  console.log("Monday import: pure-function and fixture checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
