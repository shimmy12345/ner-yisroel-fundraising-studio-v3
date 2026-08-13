import { unzipSync } from "fflate";
import gematriya from "gematriya";
import { hebrewScriptToMonthName } from "../calendar/hebrew-date.ts";

// Parses a Yahrtzeit workbook (.xlsx) into raw rows. Same in-memory
// zip/XML approach as lib/import/monday-workbook.ts (fflate, direct <c>
// cell scan by column letter, not a fragile <row>-wrapper regex), kept as
// its own small parser rather than sharing monday-workbook.ts's internals:
// this workbook is a flat one-row-per-yahrtzeit table with its own column
// set, not Monday's donor/subitem hierarchy, so there's nothing to share
// beyond ~40 lines of low-level XML parsing.
//
// Column contract (matched by header text in row 1, not a fixed letter --
// same reasoning as Monday's Code-column shift): Code, YFNameE, YLNameE,
// YEngName, YLRelType, YHebrewName, HebMonth, HebDay, HebYear. HebMonth/
// HebDay/HebYear are the canonical Hebrew-script columns -- Hebrew day and
// year are Hebrew numerals (gematriya), decoded here rather than relying on
// any English/Arabic-numeral "old" columns some exports may or may not
// carry alongside them.

export type YahrtzeitWorkbookRow = {
  rowNumber: number;
  donorCode: string | null;
  deceasedNameEnglish: string | null;
  deceasedNameHebrew: string | null;
  relationship: string | null;
  hebrewMonthRaw: string | null;
  hebrewDayRaw: string | null;
  hebrewYearRaw: string | null;
};

function decodeXmlEntities(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRegex = /<si>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = siRegex.exec(xml))) {
    const texts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
    strings.push(decodeXmlEntities(texts.join("")));
  }
  return strings;
}

function colToIndex(col: string) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

type Grid = Map<number, Map<number, string | null>>;

function parseGrid(sheetXml: string, sharedStrings: string[]): Grid {
  const grid: Grid = new Map();
  const cellRegex = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(sheetXml))) {
    const [, col, rowStr, attrs, content = ""] = match;
    const rowNum = Number(rowStr);
    const typeMatch = /t="([^"]+)"/.exec(attrs);
    const type = typeMatch ? typeMatch[1] : "n";
    const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(content);
    let value: string | null = valueMatch ? valueMatch[1] : null;
    if (value !== null && type === "s") value = sharedStrings[Number(value)] ?? null;
    if (value === null) {
      const inlineMatch = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(content);
      if (inlineMatch) value = decodeXmlEntities(inlineMatch[1]);
    }
    if (!grid.has(rowNum)) grid.set(rowNum, new Map());
    grid.get(rowNum)!.set(colToIndex(col), value);
  }
  return grid;
}

const HEADER_LABELS = {
  donorCode: "Code",
  deceasedNameEnglish: "YEngName",
  relationship: "YLRelType",
  deceasedNameHebrew: "YHebrewName",
  hebrewMonthRaw: "HebMonth",
  hebrewDayRaw: "HebDay",
  hebrewYearRaw: "HebYear",
} as const;

export function parseYahrtzeitWorkbook(fileBytes: Uint8Array): YahrtzeitWorkbookRow[] {
  const files = unzipSync(fileBytes, { filter: (file) => file.name === "xl/worksheets/sheet1.xml" || file.name === "xl/sharedStrings.xml" });
  const decoder = new TextDecoder("utf-8");
  const sheetXml = files["xl/worksheets/sheet1.xml"] ? decoder.decode(files["xl/worksheets/sheet1.xml"]) : "";
  const sharedXml = files["xl/sharedStrings.xml"] ? decoder.decode(files["xl/sharedStrings.xml"]) : "";
  if (!sheetXml) throw new Error("This file does not look like a Yahrtzeit workbook (no worksheet found).");
  const sharedStrings = parseSharedStrings(sharedXml);
  const grid = parseGrid(sheetXml, sharedStrings);
  const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
  if (rowNumbers.length === 0) return [];

  const headerRowNum = rowNumbers[0];
  const headerRow = grid.get(headerRowNum)!;
  const columnIndex: Partial<Record<keyof typeof HEADER_LABELS, number>> = {};
  for (const [col, value] of headerRow) {
    const trimmed = (value ?? "").toString().trim();
    for (const [key, label] of Object.entries(HEADER_LABELS)) {
      if (trimmed === label) columnIndex[key as keyof typeof HEADER_LABELS] = col;
    }
  }
  const missing = (Object.keys(HEADER_LABELS) as (keyof typeof HEADER_LABELS)[]).filter((key) => columnIndex[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`This file does not look like a Yahrtzeit workbook (missing column${missing.length > 1 ? "s" : ""}: ${missing.map((key) => HEADER_LABELS[key]).join(", ")}).`);
  }

  const rows: YahrtzeitWorkbookRow[] = [];
  for (const rowNum of rowNumbers) {
    if (rowNum <= headerRowNum) continue;
    const cells = grid.get(rowNum)!;
    const get = (key: keyof typeof HEADER_LABELS) => {
      const raw = (cells.get(columnIndex[key]!) ?? "").toString().trim().replace(/^‎+/, "");
      return raw || null;
    };
    const row: YahrtzeitWorkbookRow = {
      rowNumber: rowNum,
      donorCode: get("donorCode"),
      deceasedNameEnglish: get("deceasedNameEnglish"),
      deceasedNameHebrew: get("deceasedNameHebrew"),
      relationship: get("relationship"),
      hebrewMonthRaw: get("hebrewMonthRaw"),
      hebrewDayRaw: get("hebrewDayRaw"),
      hebrewYearRaw: get("hebrewYearRaw"),
    };
    if (!row.donorCode && !row.deceasedNameEnglish && !row.hebrewMonthRaw) continue; // fully blank row
    rows.push(row);
  }
  return rows;
}

// Hebrew-numeral (gematriya) day/year decoding. `order: true` matches
// standard Hebrew-numeral reading (the same mode used against every real
// value in the source workbook during design review); it degrades to plain
// summation for values without positional structure, which is what a
// single- or double-letter day/year numeral is anyway.
export function decodeGematriyaNumber(value: string): number | null {
  const cleaned = value.replace(/[׳"'״]/g, "").trim();
  if (!cleaned) return null;
  const n = gematriya(cleaned, { order: true });
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// HebYear values in this workbook omit the thousands digit (ה, =5000) --
// "תשעד" not "התשעד" for 5774 -- the standard convention once the count of
// Hebrew years has been in the 5000s for centuries. Every value observed in
// the real workbook is in the 700-999 range once decoded, consistent with
// this assumption; a decoded value already >= 5000 is left as-is.
export function decodeGematriyaYear(value: string): number | null {
  const decoded = decodeGematriyaNumber(value);
  if (decoded === null) return null;
  return decoded >= 1000 ? decoded : decoded + 5000;
}

export { hebrewScriptToMonthName };
