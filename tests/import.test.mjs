import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { decodeCsv, parseCsv, parseXlsx, rowsToRecords } from "../lib/import/file-parsers.ts";
import { buildImportPreview, recognizeColumns } from "../lib/import/recognition.ts";
import { buildJlPreview, isJlSolutionsExport, JL_COLUMNS, JL_MAPPING } from "../lib/import/jl-solutions.ts";
import { matchJlDonors, sourceSnapshot } from "../lib/import/jl-match.ts";

function workbookFixture() {
  const files = {
    "xl/workbook.xml": strToU8('<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Donors" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8('<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Donor Name</t></is></c><c r="B1" t="inlineStr"><is><t>Gift Amount</t></is></c><c r="C1" t="inlineStr"><is><t>Contribution Date</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Elena Chen</t></is></c><c r="B2"><v>25000</v></c><c r="C2" t="inlineStr"><is><t>2026-07-01</t></is></c></row></sheetData></worksheet>'),
  };
  const zipped = zipSync(files);
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

async function run() {
  const csv = parseCsv('Donor Name,Gift Amount,Gift Note\n"Chen, Elena","$25,000","Asked, then gave"\n');
  assert.equal(csv[1][0], "Chen, Elena");
  assert.equal(csv[1][2], "Asked, then gave");

  const xlsx = parseXlsx(workbookFixture());
  assert.deepEqual(xlsx[0], ["Donor Name", "Gift Amount", "Contribution Date"]);
  assert.deepEqual(xlsx[1], ["Elena Chen", "25000", "2026-07-01"]);

  const table = rowsToRecords(xlsx);
  assert.equal(table.rows.length, 1);
  const recognition = recognizeColumns(table.columns);
  const donorName = recognition.find((item) => item.column === "Donor Name");
  const contributionDate = recognition.find((item) => item.column === "Contribution Date");
  assert.equal(donorName?.field, "donorName");
  assert.equal(donorName?.requiresReview, false);
  assert.equal(contributionDate?.field, "giftDate");
  assert.equal(contributionDate?.requiresReview, true);

  const windows1252 = Uint8Array.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x93, 0x48, 0x6f, 0x75, 0x73, 0x65, 0x68, 0x6f, 0x6c, 0x64, 0x94]).buffer;
  assert.equal(decodeCsv(windows1252), "Name\n“Household”");

  const jlColumns = [...JL_COLUMNS];
  assert.equal(isJlSolutionsExport(jlColumns), true);
  assert.equal(JL_MAPPING["Fathers E-mail"], "email");
  assert.equal(JL_MAPPING["Fathers Cell"], "phone");
  assert.equal(JL_MAPPING.Cell, "alternatePhone");
  const jlRows = [
    { Code: "JL-100", Name: "Levine Household", Address: "10 Cedar Lane", City: "Albany", State: "NY", "Zip Code": "12207-1234", "Last Name": "Levine", Home: "(555) 010-1000", Cell: "", Country: "", "Fathers E-mail": "ari@example.test", "Fathers Cell": "555-010-1001", "Husband First Name": "Ari", "Wife First Name": "Miriam", "Husband Title": "Rabbi", "Wife Title": "Dr." },
    { Code: "JL-101", Name: "O’Donnell Family", Address: "20 Oak Road", City: "Dublin", State: "", "Zip Code": "", "Last Name": "O’Donnell", Home: "", Cell: "555.010.2002", Country: "Ireland", "Fathers E-mail": "", "Fathers Cell": "", "Husband First Name": "Seán", "Wife First Name": "", "Husband Title": "", "Wife Title": "" },
  ];
  const jlPreview = buildJlPreview(jlRows, "b".repeat(64));
  assert.equal(jlPreview.donors.length, 2);
  assert.equal(jlPreview.gifts.length, 0);
  assert.equal(jlPreview.interactions.length, 0);
  assert.equal(jlPreview.reminders.length, 0);
  assert.equal(jlPreview.donors[0].contact.primaryFirstName, "Ari");
  assert.equal(jlPreview.donors[0].contact.spouseFirstName, "Miriam");
  assert.equal(jlPreview.donors[0].contact.country, "United States");
  assert.equal(jlPreview.donors[1].contact.country, "Ireland");
  assert.equal(jlPreview.donors[1].name, "O’Donnell Family");
  assert.equal(sourceSnapshot(jlPreview.donors[0]).__original["Fathers Cell"], "555-010-1001");

  const duplicateJl = buildJlPreview([...jlRows, { ...jlRows[0] }], "c".repeat(64));
  assert.equal(duplicateJl.rejectedRows.length, 1);
  assert.match(duplicateJl.rejectedRows[0].reason, /duplicate/i);
  const geographyWarning = buildJlPreview([{ ...jlRows[0], Country: "Canada" }], "e".repeat(64));
  assert.match(geographyWarning.warnings.join(" "), /state and country should be reviewed/i);

  const existing = { id: jlPreview.donors[0].id, external_id: "JL-100", display_name: "Levine Household", email: "user-edited@example.test", phone: "555-010-1001", address: "10 Cedar Lane, Albany NY 12207-1234", last_name: "Levine", primary_first_name: "Ari", spouse_first_name: "Miriam", primary_title: "Rabbi", spouse_title: "Dr.", alternate_mobile_phone: null, home_phone: "(555) 010-1000", address_line_1: "10 Cedar Lane", city: "Albany", state: "NY", postal_code: "12207-1234", country: "United States", source_snapshot: JSON.stringify({ ...sourceSnapshot(jlPreview.donors[0]), email: "ari@example.test" }) };
  const changed = buildJlPreview([{ ...jlRows[0], City: "Troy", "Fathers E-mail": "jl-new@example.test" }], "d".repeat(64));
  const matches = matchJlDonors(changed.donors, [existing]);
  assert.equal(matches[0].existing.id, existing.id);
  assert.equal(matches[0].safeUpdates.city, "Troy");
  assert.equal(matches[0].conflicts[0].field, "email");
  assert.equal(matches[0].safeUpdates.relationship_summary, undefined);

  const rows = [
    { "Donor Code": "D-1", "Donor Name": "Elena Chen", "Amount Donated": "100", "Gift Date": "2026-07-01", "Interaction Date": "2026-07-02", "Interaction Notes": "Discussed student outcomes", "Reminder Date": "2026-08-01", "Next Action": "Send outcomes" },
    { "Donor Code": "D-1", "Donor Name": "Elena Chen", "Amount Donated": "50", "Gift Date": "2026-07-03", "Interaction Date": "", "Interaction Notes": "", "Reminder Date": "", "Next Action": "" },
    { "Donor Code": "D-2", "Donor Name": "Alice Smith", "Amount Donated": "25", "Gift Date": "2026-07-04", "Interaction Date": "", "Interaction Notes": "", "Reminder Date": "", "Next Action": "" },
    { "Donor Code": "D-2", "Donor Name": "Bob Smith", "Amount Donated": "25", "Gift Date": "2026-07-04", "Interaction Date": "", "Interaction Notes": "", "Reminder Date": "", "Next Action": "" },
    { "Donor Code": "", "Donor Name": "", "Amount Donated": "25", "Gift Date": "2026-07-04", "Interaction Date": "", "Interaction Notes": "", "Reminder Date": "", "Next Action": "" },
  ];
  const mapping = {
    "Donor Code": "donorCode",
    "Donor Name": "donorName",
    "Amount Donated": "giftAmount",
    "Gift Date": "giftDate",
    "Interaction Date": "interactionDate",
    "Interaction Notes": "interactionNotes",
    "Reminder Date": "reminderDate",
    "Next Action": "nextAction",
  };
  const preview = buildImportPreview(rows, mapping, "a".repeat(64));
  assert.equal(preview.donors.length, 1);
  assert.equal(preview.gifts.length, 2);
  assert.equal(preview.interactions.length, 1);
  assert.equal(preview.reminders.length, 1);
  assert.equal(preview.rejectedRows.length, 3);
  assert.match(preview.warnings.join(" "), /duplicate donor code/i);
  assert.match(preview.warnings.join(" "), /without a matching donor/i);

  const route = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const backup = await readFile(new URL("../app/api/import/backup/route.ts", import.meta.url), "utf8");
  const experience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const help = await readFile(new URL("../app/help/page.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0002_onboarding_import.sql", import.meta.url), "utf8");
  assert.match(route, /getChatGPTUser\(\)/);
  assert.match(previewRoute, /getChatGPTUser\(\)/);
  assert.match(backup, /getChatGPTUser\(\)/);
  assert.match(route, /await env\.DB\.batch\(statements\)/);
  assert.match(route, /Nothing was imported/);
  assert.match(route, /This file has already been imported/);
  assert.match(route, /updateExisting/);
  assert.match(migration, /data_imports_file_hash_unique/);
  assert.match(experience, /Download rejected rows/);
  assert.match(experience, /Download backup/);
  assert.match(experience, /Nothing has been written/);
  assert.match(experience, /JL Solutions household export detected/);
  assert.match(experience, /Refresh From JL Solutions/);
  assert.match(route, /source_snapshot/);
  assert.doesNotMatch(route, /console\.(log|info).*rows|logger\..*email/i);
  assert.match(help, /separate JL Solutions donation export/);
  assert.match(settings, /Open data import/);
  assert.match(donorPage, /No giving history imported yet/);
  assert.match(donorPage, /No interactions recorded yet/);
  assert.match(donorPage, /No next action set/);
  assert.doesNotMatch(experience, /api\/assistant|openai|anthropic/i);

  process.stdout.write("Onboarding import checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
