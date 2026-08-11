import { unzipSync } from "fflate";

// Parses a Monday.com "Pipeline" export (.xlsx) into donor blocks: a donor
// header row (Name, Code) followed by zero or more subitem rows (task
// text, Monday's own Due Date). No network, no filesystem -- xlsx is a
// zip of XML, unzipped in memory (fflate, already a dependency) and read
// with a direct cell-by-cell scan rather than a <row>-wrapper regex --
// the latter was tried first against the real export and silently
// misaligned columns on some rows (see the design turns that verified
// this against the actual workbook). Scanning every <c> element directly
// avoids that class of bug entirely.

export type MondaySubitem = { text: string; dueDateRaw: string | null; index: number };
export type MondayDonorBlock = { name: string; code: string | null; subitems: MondaySubitem[] };

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

// Reconstructs donor blocks from the flat grid. Layout (verified against
// the real export): row 1 title, row 2 group label, row 3 "Name |
// Subitems | Date of Last Contact | Code" header. Each donor is a header
// row (Name in col 0, Code in col 3 -- col 1/2 are consistently blank in
// this export) optionally followed by a "Subitems | Name | Due Date"
// mini-header and its subitem rows (col 0 blank, task text in col 1, due
// date in col 2).
export function parseMondayWorkbook(fileBytes: Uint8Array): MondayDonorBlock[] {
  const files = unzipSync(fileBytes, { filter: (file) => file.name === "xl/worksheets/sheet1.xml" || file.name === "xl/sharedStrings.xml" });
  const decoder = new TextDecoder("utf-8");
  const sheetXml = files["xl/worksheets/sheet1.xml"] ? decoder.decode(files["xl/worksheets/sheet1.xml"]) : "";
  const sharedXml = files["xl/sharedStrings.xml"] ? decoder.decode(files["xl/sharedStrings.xml"]) : "";
  if (!sheetXml) throw new Error("This file does not look like a Monday.com pipeline export (no worksheet found).");
  const sharedStrings = parseSharedStrings(sharedXml);
  const grid = parseGrid(sheetXml, sharedStrings);

  const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
  const donors: MondayDonorBlock[] = [];
  let current: MondayDonorBlock | null = null;
  for (const rowNum of rowNumbers) {
    if (rowNum <= 3) continue; // title, group label, top-level column header
    const cells = grid.get(rowNum)!;
    const c0 = (cells.get(0) ?? "").toString().trim();
    const c1 = (cells.get(1) ?? "").toString().trim();
    const c2 = (cells.get(2) ?? "").toString().trim();
    const c3 = (cells.get(3) ?? "").toString().trim();
    if (c0 === "Subitems" && c1 === "Name") continue; // subitem mini-header
    if (!c0 && !c1 && !c2 && !c3) continue; // fully blank row
    if (c0 && c0 !== "Subitems") {
      current = { name: c0, code: c3 || null, subitems: [] };
      donors.push(current);
    } else if (!c0 && c1 && current) {
      current.subitems.push({ text: c1, dueDateRaw: c2 || null, index: current.subitems.length });
    }
  }
  return donors;
}

// Excel's date epoch (1900-01-01, with the historical leap-year bug baked
// into this well-known constant) to an ISO calendar date. Monday's Due
// Date is a plain calendar day with no time component in this export.
export function excelSerialToIsoDate(serial: string | null): string | null {
  if (!serial) return null;
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  return new Date(Math.round((n - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
}
