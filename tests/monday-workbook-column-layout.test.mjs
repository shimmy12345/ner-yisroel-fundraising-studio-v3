import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { parseMondayWorkbook } from "../lib/import/monday-workbook.ts";
import { buildMondayPreview } from "../lib/import/monday-pipeline.ts";

// Regression shape taken directly from the real Monday.com export that
// exposed the bug: "Name | Subitems | (blank) | (blank) | Code" -- Code
// sits in column E, not column D. A hardcoded column-D read silently saw
// an always-blank cell and reported every donor, and therefore every
// subitem under it, as having no code at all. This file reproduces that
// exact column layout (never column D, unlike tests/monday-import.test.mjs's
// synthetic fixture, which is internally consistent on its own but does not
// exercise this specific header/data column mismatch).

function cellInline(col, row, value) {
  if (value === null || value === undefined || value === "") return "";
  const escaped = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<c r="${col}${row}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
}
function cellNumber(col, row, value) {
  if (value === null || value === undefined) return "";
  return `<c r="${col}${row}"><v>${value}</v></c>`;
}
function xlsxBytes(rowsXml) {
  const sheetXml = `<?xml version="1.0"?><worksheet><sheetData>${rowsXml}</sheetData></worksheet>`;
  return zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheetXml) });
}

const HEADER_ROWS =
  `<row r="1">${cellInline("A", 1, "Pipeline // Shimmy 2025-2026")}</row>` +
  `<row r="2">${cellInline("A", 2, "Prospects - שרי אלפים")}</row>` +
  `<row r="3">${cellInline("A", 3, "Name")}${cellInline("B", 3, "Subitems")}${cellInline("E", 3, "Code")}</row>`;

function donorRow(rowNum, name, code) {
  return `<row r="${rowNum}">${cellInline("A", rowNum, name)}${code ? cellInline("E", rowNum, code) : ""}</row>`;
}
function miniHeaderRow(rowNum) {
  return `<row r="${rowNum}">${cellInline("A", rowNum, "Subitems")}${cellInline("B", rowNum, "Name")}${cellInline("C", rowNum, "Due Date")}${cellInline("D", rowNum, "Status")}</row>`;
}
function subitemRow(rowNum, text, dueSerial, status) {
  return `<row r="${rowNum}">${cellInline("B", rowNum, text)}${dueSerial ? cellNumber("C", rowNum, dueSerial) : ""}${status ? cellInline("D", rowNum, status) : ""}</row>`;
}

async function run() {
  // --- 1 & 2: parent code inherited by every subitem, and context resets
  // cleanly at the next donor row (Abdelhak -> Berger, the exact pair from
  // the real workbook that exposed the bug). ---
  const rows =
    HEADER_ROWS +
    donorRow(4, "Abdelhak, Yakov", "49026") +
    miniHeaderRow(5) +
    subitemRow(6, "Personal invite to Teaneck event", 45537, "") +
    subitemRow(7, "Text him, share committee update when seeing in person", 45901, "Done") +
    subitemRow(8, "Solicit for $10k", 45959, "Done") +
    donorRow(9, "Berger, Mendy", "71260") +
    miniHeaderRow(10) +
    subitemRow(11, "Schedule meeting in Chicago", 46139, "Done");
  const donors = parseMondayWorkbook(xlsxBytes(rows));
  assert.equal(donors.length, 2);
  const [abdelhak, berger] = donors;
  assert.equal(abdelhak.name, "Abdelhak, Yakov");
  assert.equal(abdelhak.code, "49026", "the parent's own code must be read from column E, not the always-blank column D");
  assert.equal(abdelhak.subitems.length, 3, "every subitem row under this parent must be captured");
  assert.deepEqual(abdelhak.subitems.map((item) => item.text), [
    "Personal invite to Teaneck event",
    "Text him, share committee update when seeing in person",
    "Solicit for $10k",
  ]);
  // Subitems carry no code field of their own -- inheriting the parent's
  // code means belonging to this donor block, not duplicating the value
  // onto each row.
  for (const item of abdelhak.subitems) assert.ok(!("code" in item), "a subitem must never carry its own code field");

  assert.equal(berger.name, "Berger, Mendy");
  assert.equal(berger.code, "71260", "the next donor's code must not leak from the previous parent, nor be lost");
  assert.equal(berger.subitems.length, 1);
  assert.notEqual(abdelhak.code, berger.code, "context must switch cleanly between donors");

  // --- 3: a true no-code donor (blank Code cell, not a parsing failure)
  // remains no-code. ---
  const noCodeRows =
    HEADER_ROWS +
    donorRow(4, "Grubner, Ari", null) +
    miniHeaderRow(5) +
    subitemRow(6, "Reach out", null, "");
  const [noCodeDonor] = parseMondayWorkbook(xlsxBytes(noCodeRows));
  assert.equal(noCodeDonor.code, null, "a genuinely blank Code cell must stay null, never inferred from the name");
  assert.equal(noCodeDonor.subitems.length, 1, "a no-code donor's subitems must still be captured for review");

  // --- 4: an explicit code that simply isn't in this workspace stays
  // unmatched -- never silently treated as no-code, and never matched by
  // name. This is a pipeline-level (not parser-level) property; the parser
  // must at least preserve the raw code text unchanged for this to work. ---
  const unmatchedRows =
    HEADER_ROWS +
    donorRow(4, "Someone Not In FOS", "99999") +
    miniHeaderRow(5) +
    subitemRow(6, "Follow up", null, "");
  const [unmatchedDonor] = parseMondayWorkbook(xlsxBytes(unmatchedRows));
  assert.equal(unmatchedDonor.code, "99999");
  const emptyLookup = new Map();
  const previewRows = buildMondayPreview([unmatchedDonor], emptyLookup, "2026-08-12");
  assert.equal(previewRows[0].match.status, "unmatched_code", "an explicit code absent from the lookup must be unmatched, not no_code");

  // --- 5: the "Subitems | Name | Due Date | Status" mini-header row must
  // never become a donor row, and must never reset/blank the current
  // parent context (it has no Name-column value of its own, and its own
  // literal "Subitems" text in the Name column is excluded by name). ---
  const miniHeaderOnlyRows =
    HEADER_ROWS +
    donorRow(4, "Kazarnovsky, Yossi", "324") +
    miniHeaderRow(5) +
    subitemRow(6, "Before mini-header repeats", null, "") +
    miniHeaderRow(7) + // a second, spurious mini-header mid-block must not start a new donor or clear `current`
    subitemRow(8, "After a repeated mini-header", null, "");
  const [singleDonor] = parseMondayWorkbook(xlsxBytes(miniHeaderOnlyRows));
  assert.equal(singleDonor.subitems.length, 2, "a repeated mini-header row must never be read as a donor row or as a subitem");
  assert.deepEqual(singleDonor.subitems.map((item) => item.text), ["Before mini-header repeats", "After a repeated mini-header"]);

  // --- 6: Monday's own Status column ("Done"/blank) is captured verbatim
  // and carried through to the preview row, purely as display signal --
  // never consulted by classification or matching. ---
  const statusRows =
    HEADER_ROWS +
    donorRow(4, "Krull, Micky", "47130") +
    miniHeaderRow(5) +
    subitemRow(6, "Schedule qualification visit", null, "Done") +
    subitemRow(7, "Schedule qualification visit", null, "");
  const [statusDonor] = parseMondayWorkbook(xlsxBytes(statusRows));
  assert.equal(statusDonor.subitems[0].status, "Done");
  assert.equal(statusDonor.subitems[1].status, null, "a blank Status cell must stay null, never default to some other value");
  const statusPreviewRows = buildMondayPreview([statusDonor], new Map([["47130", { id: "donor-1", displayName: "Krull, Micky" }]]), "2026-08-12");
  assert.equal(statusPreviewRows[0].status, "Done");
  assert.equal(statusPreviewRows[1].status, null);
  // Two rows with identical text/date and different Status must still
  // classify identically -- status is never an input to disposition.
  assert.equal(statusPreviewRows[0].text, statusPreviewRows[1].text);
  assert.equal(statusPreviewRows[0].disposition, statusPreviewRows[1].disposition, "status must never influence disposition classification");

  console.log("Monday workbook column-layout checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
