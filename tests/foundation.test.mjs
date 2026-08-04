import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function run() {
  const shell = await readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /Today/);
  assert.match(shell, /Donors/);
  assert.match(shell, /Assistant/);
  assert.doesNotMatch(shell, />Campaigns</);
  assert.match(shell, /href="\/donors"/);

  const donorDirectory = await readFile(new URL("../app/donors/page.tsx", import.meta.url), "utf8");
  const donorDirectoryExperience = await readFile(new URL("../app/donors/DonorDirectoryExperience.tsx", import.meta.url), "utf8");
  assert.match(donorDirectory, /FROM donors/);
  assert.match(donorDirectory, /Your donor households/);
  assert.match(donorDirectory, /Import or refresh data/);
  assert.match(donorDirectoryExperience, /donorNavigationHref\(relationship\.id, returnPath, origin\)/);

  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "DB");

  const stagingSeed = await readFile(new URL("../drizzle/0001_staging_sample_data.sql", import.meta.url), "utf8");
  assert.match(stagingSeed, /INSERT OR IGNORE INTO `donors`/);
  assert.match(stagingSeed, /elena\.chen@example\.org/);
  assert.match(stagingSeed, /fictional/i);
  assert.doesNotMatch(stagingSeed, /DELETE|DROP TABLE|UPDATE `donors`/i);

  const todayPage = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const localDate = await readFile(new URL("../app/components/LocalDate.tsx", import.meta.url), "utf8");
  assert.match(todayPage, /<LocalDate timezone=\{profile\.timezone\} \/>/);
  assert.doesNotMatch(todayPage, /THURSDAY, JULY 30/);
  assert.match(localDate, /Intl\.DateTimeFormat/);
  assert.match(localDate, /timeZone: timezone/);
  assert.match(todayPage, /profile\.preferredFirstName/);

  process.stdout.write("Foundation checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
