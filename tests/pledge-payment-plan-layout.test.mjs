import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Guardrail for the Error 1102-adjacent (unrelated) payment-plan editor
// overflow bug: the payment-plan form was wider than its pledge card even
// with a single open pledge, because (a) app/globals.css's
// .open-pledge-plan-list used grid-template-columns: repeat(auto-fill,
// minmax(240px, 1fr)) -- with only one grid item, auto-fill still lays out
// as many 240px+ tracks as the row's width allows and the lone card only
// occupies the first one -- and (b) .payment-plan-fields input/textarea had
// no width rule at all, so each field rendered at its browser-default
// intrinsic width, and the grid's default min-width: auto on both the field
// labels and the row itself refused to shrink below that. This is a CSS/
// layout-only fix (app/globals.css); it does not touch
// PledgePaymentPlanManagement.tsx, the API routes, or any payment-plan
// business logic -- this test proves that structurally, alongside the CSS
// guardrails, since actual pixel containment needs live visual
// verification (a plain assert can't render a grid layout).

async function run() {
  const css = await read("app/globals.css");
  const component = await read("app/donors/[id]/PledgePaymentPlanManagement.tsx");

  // ---- 1/2/3: Set payment plan / Edit plan open the editor, Cancel closes it ----
  assert.match(
    component,
    /if \(mode === "create"\) \{\s*return <PlanForm pledgeActivityId=\{pledgeActivityId\} onCancel=\{\(\) => setMode\("view"\)\} onSaved=\{refresh\} \/>;/,
    "Set payment plan must open PlanForm in create mode and Cancel must return to view mode",
  );
  assert.match(
    component,
    /if \(mode === "edit" && plan\) \{\s*return <PlanForm pledgeActivityId=\{pledgeActivityId\} initial=\{\{[^}]+planId: plan\.planId \}\} onCancel=\{\(\) => setMode\("view"\)\} onSaved=\{refresh\} \/>;/,
    "Edit plan must open PlanForm in edit mode (with the existing plan's values) and Cancel must return to view mode",
  );
  assert.match(
    component,
    /<button type="button" className="payment-plan-set-button" onClick=\{\(\) => setMode\("create"\)\}>Set payment plan<\/button>/,
    "the Set payment plan button must switch this card into create mode",
  );
  assert.match(
    component,
    /<button type="button" onClick=\{\(\) => setMode\("edit"\)\}>Edit plan<\/button>/,
    "the Edit plan button must switch this card into edit mode",
  );

  // ---- 4: the active editor gets the intended layout class/state ----
  // Both create and edit render the SAME PlanForm, whose top-level element
  // carries className "payment-plan-form" -- this is exactly what the CSS
  // fix keys off of (:has(.payment-plan-form)) to widen the active card,
  // so create and edit are structurally guaranteed to get identical layout.
  assert.match(
    component,
    /<section className="payment-plan-form" aria-label=\{initial \? "Edit payment plan" : "Set payment plan"\}>/,
    "PlanForm (shared by create and edit) must keep the payment-plan-form class the CSS layout fix targets",
  );
  assert.match(
    css,
    /\.open-pledge-plan-row:has\(\.payment-plan-form\)\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*\}/,
    "an open-pledge-plan-row containing an active payment-plan-form must span the full Open Pledges grid width, not stay pinned to one auto-fill track",
  );
  assert.match(
    css,
    /\.payment-plan-fields\s*\{[^}]*min-width:\s*0[^}]*\}/,
    "payment-plan-fields must override the grid default min-width: auto so its columns can shrink to the card's actual width",
  );
  assert.match(
    css,
    /\.payment-plan-fields label\s*\{[^}]*min-width:\s*0[^}]*\}/,
    "each payment-plan-fields label (grid item) must allow shrinking below its input's default intrinsic width",
  );
  assert.match(
    css,
    /\.payment-plan-fields input, \.payment-plan-fields textarea\s*\{[^}]*width:\s*100%;\s*max-width:\s*100%;\s*box-sizing:\s*border-box[^}]*\}/,
    "every payment-plan-fields input/textarea (select, currency, date, note) must be constrained to 100% of its parent, never its browser-default intrinsic width",
  );
  assert.match(
    css,
    /\.open-pledge-plan-row\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*\}/,
    "the pledge card itself must not be forced wider than its grid track by its content",
  );

  // ---- 5: multiple pledges remain supported ----
  const donorPage = await read("app/donors/[id]/page.tsx");
  assert.match(
    donorPage,
    /openPledgesWithPlans\.map\(\(\{ pledge, planState \}\) => <article key=\{pledge\.id\} className="open-pledge-plan-row">/,
    "each open pledge must still render its own independent open-pledge-plan-row -- the layout fix must not collapse multiple pledges into one shared card",
  );
  assert.match(
    css,
    /\.open-pledge-plan-list\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(240px,\s*1fr\)\)/,
    "compact (non-editing) pledge cards must keep their existing auto-fill grid so multiple pledges can still render side by side",
  );

  // ---- 6/7: payment-plan request/body semantics and business logic unchanged ----
  assert.match(
    component,
    /const body = \{ installmentAmountCents: parseDollarsToCents\(installment\), nextExpectedPaymentAt: nextExpected, finalExpectedPaymentAt: finalExpected, note: note\.trim\(\) \};/,
    "the save request body shape must be unchanged by a presentation-only fix",
  );
  assert.match(
    component,
    /await fetch\(`\/api\/pledge-payment-plans\/\$\{encodeURIComponent\(initial\.planId\)\}`, \{ method: "PATCH"/,
    "edit must still PATCH the existing plan by id",
  );
  assert.match(
    component,
    /await fetch\("\/api\/pledge-payment-plans", \{ method: "POST".*JSON\.stringify\(\{ pledgeActivityId, \.\.\.body \}\)/,
    "create must still POST pledgeActivityId plus the same body shape",
  );
  assert.match(
    component,
    /body: JSON\.stringify\(\{ ended: true \}\)/,
    "End Plan must still send exactly { ended: true } -- untouched by this layout fix",
  );
  assert.doesNotMatch(
    component,
    /expectedDayOfMonth/,
    "expected_day_of_month must still never be exposed as an actual field/prop (only mentioned in the file's own explanatory comment, which this pattern intentionally does not match)",
  );
  assert.doesNotMatch(
    component,
    /from ["']\.\.\/\.\.\/\.\.\/lib\/relationships\/pledge-payment-plan/,
    "the component must not import cycle/cadence computation logic -- it only displays server-derived evidence, and this fix must not change that",
  );

  console.log("pledge-payment-plan-layout: ok");
}

await run();
