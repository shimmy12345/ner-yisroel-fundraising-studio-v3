import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { parseDobCell, parseDobWorkbook } from "../lib/import/dob-workbook.ts";

// Category 1: workbook parser tests -- MM/DD/YYYY text, Excel date-cell
// serials, invalid dates, missing code, missing DOB, and Feb 29 through the
// exact same validation semantics manual Birthday entry already uses
// (shape-only, never year-aware -- see isPlausibleGregorianDate).

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
const HEADER = `<row r="1">${cellInline("A", 1, "DOB")}${cellInline("B", 1, "Code")}</row>`;
function textDobRow(rowNum, dob, code) {
  return `<row r="${rowNum}">${cellInline("A", rowNum, dob)}${cellInline("B", rowNum, code)}</row>`;
}
function serialDobRow(rowNum, serial, code) {
  return `<row r="${rowNum}">${serial === null ? "" : cellNumber("A", rowNum, serial)}${cellInline("B", rowNum, code)}</row>`;
}

async function run() {
  // --- MM/DD/YYYY and M/D/YYYY text dates. ---
  assert.deepEqual(parseDobCell("6/21/1985"), { month: 6, day: 21, year: 1985, error: null });
  assert.deepEqual(parseDobCell("12/05/1988"), { month: 12, day: 5, year: 1988, error: null });
  assert.deepEqual(parseDobCell("04-15-1991"), { month: 4, day: 15, year: 1991, error: null });

  // --- genuine Excel date-cell serial (bare number, no separators). Serial
  // 33410 is 1991-06-21 in Excel's 1900 epoch. ---
  const serialResult = parseDobCell("33410");
  assert.equal(serialResult.error, null);
  assert.equal(serialResult.month, 6);
  assert.equal(serialResult.day, 21);
  assert.equal(serialResult.year, 1991);

  // --- invalid date shapes. ---
  assert.equal(parseDobCell("13/01/1990").error, `"13/01/1990" is not a valid date.`, "month 13 must be rejected");
  assert.equal(parseDobCell("02/30/1990").error, `"02/30/1990" is not a valid date.`, "Feb 30 must be rejected -- no month ever has 30 Feb days");
  assert.equal(parseDobCell("not a date").error, `Could not read "not a date" as a date.`);

  // --- missing DOB. ---
  assert.equal(parseDobCell(null).error, "Missing date of birth.");
  assert.equal(parseDobCell("").error, "Missing date of birth.");

  // --- Feb 29: shape-only validation, plausible in every year, exactly
  // mirroring normalizeImportantDate's own validation boundary for manual
  // Birthday entry. ---
  assert.deepEqual(parseDobCell("2/29/2000"), { month: 2, day: 29, year: 2000, error: null });
  assert.deepEqual(parseDobCell("2/29/1991"), { month: 2, day: 29, year: 1991, error: null }, "Feb 29 is accepted even for a non-leap year -- month/day shape only, never year-aware");

  // --- full-workbook parse: text dates, a serial date, missing code,
  // missing DOB, and a fully blank row (skipped) all in one file. ---
  const rows =
    HEADER +
    textDobRow(2, "6/21/1985", "67103") +
    serialDobRow(3, "33410", "59936") +
    textDobRow(4, "13/40/1990", "11111") + // invalid date
    textDobRow(5, "", "22222") + // missing DOB
    textDobRow(6, "1/1/1990", "") + // missing code
    `<row r="7"></row>`; // fully blank row -- must be skipped entirely
  const parsed = parseDobWorkbook(xlsxBytes(rows));
  assert.equal(parsed.length, 5, "the fully blank row must never appear as a parsed row");
  assert.deepEqual(parsed.map((row) => row.rowNumber), [2, 3, 4, 5, 6]);

  assert.equal(parsed[0].donorCode, "67103");
  assert.equal(parsed[0].month, 6); assert.equal(parsed[0].day, 21); assert.equal(parsed[0].year, 1985);
  assert.equal(parsed[0].dateError, null);

  assert.equal(parsed[1].donorCode, "59936");
  assert.equal(parsed[1].month, 6); assert.equal(parsed[1].day, 21); assert.equal(parsed[1].year, 1991);

  assert.equal(parsed[2].donorCode, "11111");
  assert.ok(parsed[2].dateError, "an invalid date must be flagged with a dateError, not silently dropped");
  assert.equal(parsed[2].month, null);

  assert.equal(parsed[3].donorCode, "22222");
  assert.equal(parsed[3].dateError, "Missing date of birth.");

  assert.equal(parsed[4].donorCode, null, "a genuinely blank Code cell must stay null, never inferred");
  assert.equal(parsed[4].month, 1);

  // --- header detection is by text, not fixed column letters: DOB in
  // column B, Code in column A must parse identically. ---
  const swappedHeader = `<row r="1">${cellInline("A", 1, "Code")}${cellInline("B", 1, "DOB")}</row>`;
  const swappedRow = `<row r="2">${cellInline("A", 2, "67103")}${cellInline("B", 2, "6/21/1985")}</row>`;
  const swappedParsed = parseDobWorkbook(xlsxBytes(swappedHeader + swappedRow));
  assert.equal(swappedParsed.length, 1);
  assert.equal(swappedParsed[0].donorCode, "67103");
  assert.equal(swappedParsed[0].month, 6);

  // --- missing required column throws, rather than silently misreading. ---
  const noCodeHeader = `<row r="1">${cellInline("A", 1, "DOB")}</row>`;
  assert.throws(() => parseDobWorkbook(xlsxBytes(noCodeHeader + textDobRow(2, "1/1/1990", "1"))), /missing column/i);

  console.log("DOB workbook parser checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
