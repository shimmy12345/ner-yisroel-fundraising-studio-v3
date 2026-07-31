import { strFromU8, unzipSync } from "fflate";
import type { ImportRow } from "./recognition";

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  row.push(value.replace(/\r$/, ""));
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

export function decodeCsv(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes).replace(/^\uFEFF/, "");
  }
}

function attribute(source: string, name: string) {
  const match = source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match?.[1] ?? "";
}

function columnIndex(reference: string) {
  const letters = reference.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function excelDate(serial: number) {
  const milliseconds = Math.round((serial - 25569) * 86400000);
  return new Date(milliseconds).toISOString().slice(0, 10);
}

export function parseXlsx(buffer: ArrayBuffer): string[][] {
  const files = unzipSync(new Uint8Array(buffer));
  const read = (path: string) => files[path] ? strFromU8(files[path]) : "";
  const workbook = read("xl/workbook.xml");
  const relationships = read("xl/_rels/workbook.xml.rels");
  const firstSheetTag = workbook.match(/<sheet\b[^>]*\br:id="[^"]+"[^>]*\/?\s*>/i)?.[0];
  if (!firstSheetTag) throw new Error("The workbook does not contain a readable worksheet");
  const relationshipId = attribute(firstSheetTag, "r:id");
  const relationshipTag = [...relationships.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)]
    .map((match) => match[0])
    .find((tag) => attribute(tag, "Id") === relationshipId);
  if (!relationshipTag) throw new Error("The first worksheet could not be located");
  const target = attribute(relationshipTag, "Target").replace(/^\//, "");
  const sheetPath = target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`;
  const worksheet = read(sheetPath);
  if (!worksheet) throw new Error("The first worksheet is empty or unreadable");

  const sharedStrings = [...read("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)]
    .map((match) => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((text) => decodeXml(text[1])).join(""));

  const styles = read("xl/styles.xml");
  const customDateFormats = new Set(
    [...styles.matchAll(/<numFmt\b[^>]*\/?\s*>/gi)]
      .filter((match) => /[ymdhis]/i.test(decodeXml(attribute(match[0], "formatCode"))))
      .map((match) => Number(attribute(match[0], "numFmtId"))),
  );
  const dateFormatIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, ...customDateFormats]);
  const cellFormats = [...(styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i)?.[1] ?? "").matchAll(/<xf\b[^>]*\/?\s*>/gi)]
    .map((match) => Number(attribute(match[0], "numFmtId")));

  const rows: string[][] = [];
  for (const rowMatch of worksheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const row: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const index = columnIndex(attribute(attrs, "r"));
      const type = attribute(attrs, "t");
      const styleIndex = Number(attribute(attrs, "s"));
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1]
        ?? [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) => match[1]).join("");
      let parsed = decodeXml(raw ?? "");
      if (type === "s") parsed = sharedStrings[Number(parsed)] ?? "";
      else if (type === "b") parsed = parsed === "1" ? "TRUE" : "FALSE";
      else if (!type && parsed && dateFormatIds.has(cellFormats[styleIndex])) parsed = excelDate(Number(parsed));
      row[index] = parsed;
    }
    if (row.some((cell) => cell?.trim())) rows.push(row.map((cell) => cell ?? ""));
  }

  return rows;
}

export function rowsToRecords(rows: string[][]): { columns: string[]; rows: ImportRow[] } {
  if (rows.length < 2) throw new Error("The file needs a header row and at least one data row");
  const seen = new Map<string, number>();
  const columns = rows[0].map((value, index) => {
    const base = value.trim() || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  return {
    columns,
    rows: rows.slice(1).filter((row) => row.some((cell) => cell?.trim())).map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, String(row[index] ?? "").trim()])),
    ),
  };
}
