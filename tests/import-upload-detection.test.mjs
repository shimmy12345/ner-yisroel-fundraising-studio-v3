import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyJlImportType } from "../lib/import/jl-export-type.ts";

async function run() {
  // A donation file that also carries the household-shaped "Code"/"Name"
  // columns must classify as "donation", the same result the preview and
  // commit routes already produce for this shape (this is what the
  // upload-time screen must now agree with).
  const donationWithCodeAndName = { Code: "JL-900", Name: "Fictional Family", Campaign: "ANNUAL", "Due Date": "2025-06-15", Amount: "100.00", Paid: "100.00", "Balance Due": "0" };
  assert.equal(classifyJlImportType(Object.keys(donationWithCodeAndName), [donationWithCodeAndName]), "donation");

  // A genuinely ambiguous file (household-shaped columns plus exactly one
  // weak donation indicator) must never resolve to either type on its own.
  const ambiguousFile = { Code: "JL-3", Name: "Ambiguous Row", Amount: "50.00" };
  assert.equal(classifyJlImportType(Object.keys(ambiguousFile), [ambiguousFile]), "ambiguous");

  // A plain household file (no donation indicators at all) must still
  // classify as "household".
  const householdFile = { Code: "JL-5", Name: "Household Only", Email: "a@example.org", Phone: "555-0100" };
  assert.equal(classifyJlImportType(Object.keys(householdFile), [householdFile]), "household");

  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");

  // 1/3/4. Upload-time detection must use the exact same classifier as the
  // preview and commit routes, not the old standalone column checks. All
  // three call the same function, so they can never disagree.
  assert.doesNotMatch(importExperience, /\bisJlDonationExport\(/, "the upload screen must no longer call the old standalone donation check");
  assert.doesNotMatch(importExperience, /\bisJlSolutionsExport\(/, "the upload screen must no longer call the old standalone household check");
  assert.match(importExperience, /classifyJlImportType\(table\.columns, table\.rows\)/, "inspectFile must classify the file with the same function the server uses");
  assert.match(importExperience, /from "\.\.\/\.\.\/\.\.\/lib\/import\/jl-export-type"/);
  assert.match(previewRoute, /classifyJlImportType\(columns, rows\)/);
  assert.match(importRoute, /classifyJlImportType\(Object\.keys\(rows\[0\] \?\? \{\}\), rows\)/);

  // 1. A donation-classified file drives donationDetected off the shared
  // classifier's result, not a separate check, so it can never show the
  // household banner first.
  assert.match(importExperience, /const detectedDonation = importType === "donation"/);
  assert.match(importExperience, /const detectedJl = importType === "household"/);

  // 3. Household mapping is only ever applied when the shared classifier
  // says "household"; donation recognition only when it says "donation".
  assert.match(importExperience, /const recognized = detectedDonation \? \[\] : detectedJl/);
  assert.match(importExperience, /table\.columns\.map\(\(column\) => \(\{ column, field: JL_MAPPING\[column\]/);
  assert.match(importExperience, /: recognizeColumns\(table\.columns\)/);

  // 2. An ambiguous upload sets the chooser state immediately in
  // inspectFile — no server round trip is needed to know to ask — and the
  // recognition step renders the chooser instead of an auto-applied mapping
  // whenever that state is set.
  assert.match(importExperience, /setAmbiguousType\(importType === "ambiguous" \? \{/);
  assert.match(importExperience, /jlDetected && !ambiguousType &&/);
  assert.match(importExperience, /donationDetected && !ambiguousType &&/);
  assert.match(importExperience, /ambiguousType \? <div className="import-mode"/);
  assert.match(importExperience, /showPreview\("household"\)/);
  assert.match(importExperience, /showPreview\("donation"\)/);

  process.stdout.write("Upload-time import type detection checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
