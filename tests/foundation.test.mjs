import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function run() {
  const shell = await readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /Today/);
  assert.match(shell, /Donors/);
  assert.match(shell, /Assistant/);
  assert.doesNotMatch(shell, />Campaigns</);

  const data = await readFile(new URL("../app/data.ts", import.meta.url), "utf8");
  assert.match(data, /why:/);
  assert.match(data, /nextAction:/);

  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "DB");

  const stagingSeed = await readFile(new URL("../drizzle/0001_staging_sample_data.sql", import.meta.url), "utf8");
  assert.match(stagingSeed, /INSERT OR IGNORE INTO `donors`/);
  assert.match(stagingSeed, /elena\.chen@example\.org/);
  assert.match(stagingSeed, /fictional/i);
  assert.doesNotMatch(stagingSeed, /DELETE|DROP TABLE|UPDATE `donors`/i);

  process.stdout.write("Foundation checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
