import { buildImportPreview, type ColumnMapping, type ImportPreview, type ImportRow } from "./recognition.ts";

export const JL_COLUMNS = [
  "Code", "Name", "Address", "City", "State", "Zip Code", "Last Name", "Home", "Cell", "Country",
  "Fathers E-mail", "Fathers Cell", "Husband First Name", "Wife First Name", "Husband Title", "Wife Title",
] as const;

export const JL_MAPPING: ColumnMapping = {
  Code: "donorCode", Name: "donorName", Address: "address", City: "city", State: "state", "Zip Code": "zip",
  "Last Name": "lastName", Home: "homePhone", Cell: "alternatePhone", Country: "country",
  "Fathers E-mail": "email", "Fathers Cell": "phone", "Husband First Name": "primaryFirstName",
  "Wife First Name": "spouseFirstName", "Husband Title": "primaryTitle", "Wife Title": "spouseTitle",
};

export function isJlSolutionsExport(columns: string[]) {
  const normalized = new Set(columns.map((column) => column.trim().toLowerCase()));
  return JL_COLUMNS.every((column) => normalized.has(column.toLowerCase()));
}

function looksLikeEmail(value: string) {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function looksLikeZip(value: string) {
  return !value || /^\d{5}(?:-\d{4})?$/.test(value);
}

const US_STATES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);
const US_COUNTRIES = new Set(["united states", "united states of america", "us", "usa", "u.s.", "u.s.a."]);

function normalizedRow(row: ImportRow) {
  return JSON.stringify(JL_COLUMNS.map((column) => row[column]?.trim() ?? ""));
}

export function buildJlPreview(rows: ImportRow[], fileHash: string): ImportPreview {
  const seenCodes = new Set<string>();
  const seenRows = new Set<string>();
  const validRows: ImportRow[] = [];
  const rejectedRows: ImportPreview["rejectedRows"] = [];
  const warnings: string[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const code = row.Code?.trim();
    const name = row.Name?.trim();
    const signature = normalizedRow(row);
    let reason = "";
    if (!code) reason = "JL Code is required";
    else if (!name) reason = "Household name is required";
    else if (seenCodes.has(code.toLowerCase())) reason = "Duplicate JL Code";
    else if (seenRows.has(signature)) reason = "Duplicate row";
    else if (!looksLikeEmail(row["Fathers E-mail"]?.trim() ?? "")) reason = "Email format is invalid";
    else if (!looksLikeZip(row["Zip Code"]?.trim() ?? "")) reason = "ZIP code format is invalid";
    if (reason) rejectedRows.push({ row: rowNumber, reason, values: row });
    else {
      seenCodes.add(code.toLowerCase());
      seenRows.add(signature);
      validRows.push(row);
      const state = row.State?.trim().toUpperCase() ?? "";
      const country = row.Country?.trim().toLowerCase() ?? "";
      if (US_STATES.has(state) && country && !US_COUNTRIES.has(country)) warnings.push(`Row ${rowNumber}: U.S. state and country should be reviewed`);
      else if (state && state.length === 2 && !US_STATES.has(state) && !country) warnings.push(`Row ${rowNumber}: state and country should be reviewed`);
    }
  });

  if (rejectedRows.length) warnings.push(`${rejectedRows.length} household row${rejectedRows.length === 1 ? "" : "s"} will be rejected`);
  const preview = buildImportPreview(validRows, JL_MAPPING, fileHash);
  preview.donors.forEach((donor) => {
    donor.sourceProfile = "jl-solutions";
    const sourceRow = validRows.find((row) => row.Code?.trim().toLowerCase() === donor.donorCode?.toLowerCase());
    donor.sourceValues = sourceRow ? Object.fromEntries(JL_COLUMNS.map((column) => [column, sourceRow[column]?.trim() ?? ""])) : {};
  });
  return { ...preview, rejectedRows: [...rejectedRows, ...preview.rejectedRows], warnings: [...warnings, ...preview.warnings] };
}
