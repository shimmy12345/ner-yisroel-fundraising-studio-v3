import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function run() {
  const page = await readFile(new URL("../app/assistant/page.tsx", import.meta.url), "utf8");
  const brief = await readFile(new URL("../app/components/AssistantBrief.tsx", import.meta.url), "utf8");

  assert.match(page, /<AssistantBrief \/>/);
  assert.match(brief, /Read full brief/);
  assert.match(brief, /Collapse full brief/);
  assert.match(brief, /aria-expanded=\{isExpanded\}/);
  assert.match(brief, /Top priorities/);
  assert.match(brief, /Today’s meetings/);
  assert.match(brief, /New gifts/);
  assert.match(brief, /Recommended focus/);
  assert.match(brief, /speechSynthesis\.speak/);
  assert.match(brief, /speechSynthesis\.pause/);
  assert.match(brief, /speechSynthesis\.resume/);
  assert.match(brief, /speechSynthesis\.cancel/);
  assert.match(brief, /Listening is not supported in this browser/);
  assert.match(brief, /return \(\) =>/);

  process.stdout.write("Assistant brief checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
