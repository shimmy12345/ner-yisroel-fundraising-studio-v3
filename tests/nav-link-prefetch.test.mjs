import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Guardrail for the Error 1102 CPU-limit investigation (2026-08-17): AppShell's
// sidebar and MobileMoreMenu's panel are persistent, always-registered navigation
// -- every render observes them for viewport prefetch regardless of which page is
// active. Their Today/Import/Assistant/Settings destinations are all
// `force-dynamic` with no `loading.tsx`, so vinext's automatic prefetch policy
// (see resolveAutoAppRoutePrefetch in vinext's link shim) fetches the FULL RSC
// payload -- running the real server loader, not a placeholder shell -- the
// moment the link scrolls within 250px of the viewport. Today and Assistant
// both independently run loadWorkspaceBrief()'s 14-query D1 fan-out plus a
// donor-roster recommendation-scoring loop. A single donor-page visit was
// observed triggering simultaneous "Worker exceeded CPU time limit" failures
// across these routes, because the always-visible sidebar auto-prefetched all
// of them at once. `/help` is excluded here: it is statically rendered (no
// `dynamic = "force-dynamic"`, no D1 calls), so there is no CPU cost to guard
// against and disabling its prefetch would not be evidence-supported.
//
// This test fails if a future edit silently drops `prefetch={false}` from any
// of these specific Links -- it does not require every Link in the app to
// disable prefetch, only the ones proven expensive by that incident.

async function run() {
  const appShell = await read("app/components/AppShell.tsx");
  const mobileMoreMenu = await read("app/components/MobileMoreMenu.tsx");

  // ---- AppShell: brand logo + primary nav (Today/Import/Assistant) ----
  assert.match(
    appShell,
    /<Link className="brand" href="\/" prefetch=\{false\}>/,
    "AppShell brand logo link (-> /) must not auto-prefetch the Today workspace brief",
  );
  assert.match(
    appShell,
    /<Link className=\{active === "today" \? "active" : ""\} href="\/" prefetch=\{false\}>/,
    "AppShell Today nav link must not auto-prefetch loadWorkspaceBrief()",
  );
  assert.match(
    appShell,
    /<Link className=\{active === "import" \? "active" : ""\} href="\/onboarding\/import" prefetch=\{false\}>/,
    "AppShell Import nav link must not auto-prefetch the import-center loaders",
  );
  assert.match(
    appShell,
    /<Link className=\{active === "assistant" \? "active" : ""\} href="\/assistant" prefetch=\{false\}>/,
    "AppShell Assistant nav link must not auto-prefetch loadWorkspaceBrief()",
  );

  // ---- AppShell: sidebar-bottom Settings (secondary link + profile row) ----
  assert.match(
    appShell,
    /<Link className=\{`secondary-link \$\{active === "settings" \? "active" : ""\}`\} href="\/settings" prefetch=\{false\}>/,
    "AppShell Settings secondary-link must not auto-prefetch loadDataHealth()",
  );
  assert.match(
    appShell,
    /<Link className="profile" href="\/settings" prefetch=\{false\}>/,
    "AppShell profile row link (-> /settings) must not auto-prefetch loadDataHealth()",
  );

  // ---- AppShell: Help stays untouched (static page, no evidence of cost) ----
  assert.match(
    appShell,
    /<Link className=\{`secondary-link \$\{active === "help" \? "active" : ""\}`\} href="\/help"><span>/,
    "AppShell Help link is intentionally left at default prefetch -- /help is statically rendered",
  );

  // ---- MobileMoreMenu: Settings (nav link + profile row) ----
  assert.match(
    mobileMoreMenu,
    /<Link href="\/settings" onClick=\{\(\) => setOpen\(false\)\} className=\{active === "settings" \? "active" : ""\} prefetch=\{false\}>/,
    "MobileMoreMenu Settings link must not auto-prefetch loadDataHealth()",
  );
  assert.match(
    mobileMoreMenu,
    /<Link className="nav-more-profile" href="\/settings" onClick=\{\(\) => setOpen\(false\)\} prefetch=\{false\}>/,
    "MobileMoreMenu profile row link (-> /settings) must not auto-prefetch loadDataHealth()",
  );

  // ---- MobileMoreMenu: Help stays untouched ----
  assert.match(
    mobileMoreMenu,
    /<Link href="\/help" onClick=\{\(\) => setOpen\(false\)\} className=\{active === "help" \? "active" : ""\}><span>/,
    "MobileMoreMenu Help link is intentionally left at default prefetch -- /help is statically rendered",
  );

  console.log("nav-link-prefetch: ok");
}

await run();
