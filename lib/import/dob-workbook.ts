import { unzipSync } from "fflate";
import { isPlausibleGregorianDate } from "../calendar/gregorian-recurring-date.ts";

// Parses a Date of Birth workbook (.xlsx) into raw rows. Same in-memory
// zip/XML approach as lib/import/yahrtzeit-workbook.ts and lib/import/
// monday-workbook.ts (fflate, direct <c> cell scan by column letter) --
// kept as its own small parser rather than sharing internals: this
// workbook is a flat two-column table (DOB, Code), nothing to share
// beyond the same ~40 lines of low-level XML parsing every workbook
// importer in this app already duplicates for its own column set.
//
// Column contract (matched by header text in row 1, not a fixed letter):
// DOB, Code. DOB may arrive as either a genuine Excel date cell (a bare
// numeric serial, no separators) or as pre-formatted text (MM/DD/YYYY or
// M/D/YYYY, "/" or "-" separated) -- both are real shapes real donor
// database exports produce, so both are handled here rather than assuming
// one.

export type DobWorkbookRow = {
  rowNumber: number;
  donorCode: string | null;
  dobRaw: string | null;
  month: number | null;
  day: number | null;
  year: number | null;
  // Set only when dobRaw was present but could not be read as a date --
  // distinct from "missing DOB" so the preview can give an accurate reason.
  dateError: string | null;
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

const HEADER_LABELS = { donorCode: "Code", dobRaw: "DOB" } as const;

// Same conversion the Monday importer already relies on for its own date
// columns (lib/import/monday-workbook.ts's excelSerialToIsoDate) --
// duplicated here at the same tiny size rather than imported, matching
// this codebase's existing convention of each workbook parser owning its
// own small, self-contained parsing helpers. Excel's serial epoch is day 1
// = 1899-12-31, with the well-known (and here intentionally reproduced,
// for consistency with every other importer's date columns) 1900 leap-year
// bug baked into the -25569 offset to Unix epoch days.
function excelSerialToIsoDate(serial: string): string | null {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  return new Date(Math.round((n - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
}

// Parses one DOB cell's raw text into month/day/year, or a human-readable
// error. Only checks date SHAPE (isPlausibleGregorianDate -- the same
// month/day plausibility check normalizeImportantDate itself uses), never
// a year-aware "did Feb 29 actually occur in that year" check -- a
// birthday's month/day is stored as entered regardless of the year, and
// leap-year alignment is a display-time concern (see lib/calendar/
// gregorian-recurring-date.ts's own Feb 29 policy), never an import-time
// rejection. This deliberately reuses the exact same validation boundary
// manual Birthday entry already has -- a future workbook containing a Feb
// 29 DOB is accepted here exactly like a manually-typed one would be.
export function parseDobCell(raw: string | null): { month: number | null; day: number | null; year: number | null; error: string | null } {
  if (!raw) return { month: null, day: null, year: null, error: "Missing date of birth." };
  const trimmed = raw.trim();

  const textMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (textMatch) {
    const month = Number(textMatch[1]);
    const day = Number(textMatch[2]);
    const year = Number(textMatch[3]);
    if (!isPlausibleGregorianDate(month, day)) return { month: null, day: null, year: null, error: `"${trimmed}" is not a valid date.` };
    return { month, day, year, error: null };
  }

  // A bare number with no date separators -- a genuine Excel date-typed
  // cell always serializes to raw XML as just its numeric serial,
  // regardless of the cell's display format.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const iso = excelSerialToIsoDate(trimmed);
    const parts = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
    if (!parts) return { month: null, day: null, year: null, error: `Could not read "${trimmed}" as a date.` };
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    if (!isPlausibleGregorianDate(month, day)) return { month: null, day: null, year: null, error: `"${trimmed}" is not a valid date.` };
    return { month, day, year, error: null };
  }

  return { month: null, day: null, year: null, error: `Could not read "${trimmed}" as a date.` };
}

export function parseDobWorkbook(fileBytes: Uint8Array): DobWorkbookRow[] {
  const files = unzipSync(fileBytes, { filter: (file) => file.name === "xl/worksheets/sheet1.xml" || file.name === "xl/sharedStrings.xml" });
  const decoder = new TextDecoder("utf-8");
  const sheetXml = files["xl/worksheets/sheet1.xml"] ? decoder.decode(files["xl/worksheets/sheet1.xml"]) : "";
  const sharedXml = files["xl/sharedStrings.xml"] ? decoder.decode(files["xl/sharedStrings.xml"]) : "";
  if (!sheetXml) throw new Error("This file does not look like a Date of Birth workbook (no worksheet found).");
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
    throw new Error(`This file does not look like a Date of Birth workbook (missing column${missing.length > 1 ? "s" : ""}: ${missing.map((key) => HEADER_LABELS[key]).join(", ")}).`);
  }

  const rows: DobWorkbookRow[] = [];
  for (const rowNum of rowNumbers) {
    if (rowNum <= headerRowNum) continue;
    const cells = grid.get(rowNum)!;
    const get = (key: keyof typeof HEADER_LABELS) => {
      const raw = (cells.get(columnIndex[key]!) ?? "").toString().trim();
      return raw || null;
    };
    const donorCode = get("donorCode");
    const dobRaw = get("dobRaw");
    if (!donorCode && !dobRaw) continue; // fully blank row
    const { month, day, year, error } = parseDobCell(dobRaw);
    rows.push({ rowNumber: rowNum, donorCode, dobRaw, month, day, year, dateError: error });
  }
  return rows;
}
