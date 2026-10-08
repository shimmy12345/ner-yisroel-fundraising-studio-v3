import assert from "node:assert/strict";
import fs from "node:fs";
import { validateCustomDurationInput, MIN_COMMITMENT_DURATION_MONTHS, MAX_COMMITMENT_DURATION_MONTHS } from "../lib/capture/pledge-payment-plan.ts";

// Custom-duration input-field correction (2026-10-08, see docs/AI-HANDOFF.md).
// Bug: PledgePaymentPlanManagement.tsx's "Custom…" field fed raw text
// through Number.parseInt, which silently truncates instead of
// rejecting -- "9.5" became 9, "12abc" became 12. A fundraiser could
// accidentally save an incorrect commitment duration and generate
// renewal reminders on the wrong dates. validateCustomDurationInput is
// the fix: it validates the ENTIRE string (never a partial parse) and
// is imported directly by the component -- these tests exercise it the
// same way the UI does, plus structural checks that the component
// actually wires it in (never falls back to the old Number.parseInt
// behavior).

async function run() {
  // --- 1/2: a valid custom duration is accepted, and resolves to
  // EXACTLY the typed value -- never truncated, rounded, or substituted. ---
  {
    assert.deepEqual(validateCustomDurationInput("9"), { ok: true, months: 9 });
    assert.deepEqual(validateCustomDurationInput("1"), { ok: true, months: 1 });
    assert.deepEqual(validateCustomDurationInput("120"), { ok: true, months: 120 }, "the documented maximum must be accepted");
    assert.deepEqual(validateCustomDurationInput("  9  "), { ok: true, months: 9 }, "surrounding whitespace is trimmed, not rejected");
    assert.deepEqual(validateCustomDurationInput("036"), { ok: true, months: 36 }, "a leading zero is still an unambiguous whole number");
  }

  // --- 3a: fractional input is rejected outright -- NEVER truncated to
  // its integer part. This is the exact bug report: "9.5" must not
  // silently become 9. ---
  {
    const result = validateCustomDurationInput("9.5");
    assert.equal(result.ok, false, "9.5 must be rejected, not silently truncated to 9");
    assert.match(result.reason, /whole number/i);
    assert.equal(validateCustomDurationInput("12.0").ok, false, "even a fractional value with a zero fractional part must be rejected -- the input text itself contains a decimal point");
  }

  // --- 3b: non-numeric/garbage-suffixed input is rejected outright --
  // NEVER silently reinterpreted as its leading numeric prefix. This is
  // the exact bug report: "12abc" must not silently become 12. ---
  {
    const result = validateCustomDurationInput("12abc");
    assert.equal(result.ok, false, "12abc must be rejected, not silently truncated to 12");
    assert.match(result.reason, /whole number/i);
    assert.equal(validateCustomDurationInput("twelve").ok, false);
    assert.equal(validateCustomDurationInput("1e2").ok, false, "scientific notation must never be accepted as a whole number");
    assert.equal(validateCustomDurationInput("12 months").ok, false);
  }

  // --- 3c: empty custom input is rejected -- choosing "Custom…" but
  // leaving the field blank must never silently resolve to null/0/a
  // default; it must block saving with a clear message. ---
  {
    const result = validateCustomDurationInput("");
    assert.equal(result.ok, false);
    assert.match(result.reason, /enter a whole number/i);
    assert.equal(validateCustomDurationInput("   ").ok, false, "whitespace-only input is still empty once trimmed");
  }

  // --- 3d: zero and negative values are rejected. ---
  {
    assert.equal(validateCustomDurationInput("0").ok, false, "zero months is not a real commitment length");
    assert.equal(validateCustomDurationInput("-6").ok, false, "a negative duration must be rejected, never reinterpreted as its absolute value");
  }

  // --- 3e: values above the documented maximum (120) are rejected. ---
  {
    const result = validateCustomDurationInput("121");
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(`${MIN_COMMITMENT_DURATION_MONTHS}.*${MAX_COMMITMENT_DURATION_MONTHS}`));
    assert.equal(validateCustomDurationInput("9999").ok, false);
  }

  // --- 4: never truncates, rounds, or silently substitutes -- a sweep
  // of every invalid case above confirms none of them resolve to ANY
  // number at all (ok: false carries no numeric value to accidentally use). ---
  {
    for (const invalid of ["9.5", "12abc", "", "0", "-6", "121", "1e2", "NaN", "null", "undefined", "++6", "6 "]) {
      const result = validateCustomDurationInput(invalid);
      if (invalid === "6 ") continue; // trims to "6", a legitimately valid value
      assert.equal(result.ok, false, `"${invalid}" must be rejected`);
      assert.ok(!("months" in result), `"${invalid}"'s rejection must carry no numeric value of any kind`);
    }
    // Confirms the trim-only exception above really is valid (whitespace
    // around an otherwise-clean digit string is not "garbage").
    assert.deepEqual(validateCustomDurationInput("6 "), { ok: true, months: 6 });
  }

  // ============================================================
  // Component wiring -- structural checks (this repo's established
  // "no browser/React test harness" convention for "use client"
  // components, matching tests/pledge-payment-plan-layout.test.mjs).
  // ============================================================
  {
    const component = fs.readFileSync(new URL("../app/donors/[id]/PledgePaymentPlanManagement.tsx", import.meta.url), "utf8");

    // --- The component imports and uses the shared validator -- never
    // its own re-implementation, and never the old Number.parseInt
    // path for the custom field. ---
    assert.match(component, /import \{ validateCustomDurationInput, MIN_COMMITMENT_DURATION_MONTHS, MAX_COMMITMENT_DURATION_MONTHS \} from "\.\.\/\.\.\/\.\.\/lib\/capture\/pledge-payment-plan"/, "the component must import the shared validator, never duplicate it");
    assert.match(component, /validateCustomDurationInput\(customDuration\)/, "the component must validate the raw customDuration string through the shared validator");
    assert.doesNotMatch(component, /Number\.parseInt\(customDuration/, "the custom-duration field must never be parsed with Number.parseInt again -- that is the exact bug this correction fixes");

    // --- 6: saving is prevented while the custom duration is invalid --
    // both the Save button's own disabled state and save() itself guard
    // on isCustomDurationInvalid (belt-and-suspenders, matching the
    // existing nextExpected/finalExpected convention in this same form). ---
    assert.match(component, /disabled=\{status === "saving" \|\| !nextExpected \|\| !finalExpected \|\| isCustomDurationInvalid\}/, "the Save button must be disabled while the custom duration is invalid");
    assert.match(component, /if \(status === "saving" \|\| !nextExpected \|\| !finalExpected \|\| isCustomDurationInvalid\) return;/, "save() itself must also refuse to submit while the custom duration is invalid, not rely on the disabled button alone");

    // --- 5: a clear inline validation message is rendered. ---
    assert.match(component, /isCustomDurationInvalid && customDurationValidation.*customDurationValidation\.reason/s, "an inline message explaining the problem must be rendered when the custom duration is invalid");

    // --- 7: "Not set" remains a valid, always-available option --
    // duration stays optional for saving a plan. ---
    assert.match(component, /<option value="">Not set<\/option>/);

    // --- 8: all four presets are preserved, unchanged. ---
    assert.match(component, /const COMMITMENT_DURATION_PRESETS = \[6, 12, 18, 24\] as const;/, "all four preset durations (6/12/18/24 months) must still be offered, unchanged");

    // --- 9: an existing custom value (not one of the four presets) is
    // preserved verbatim when opening a plan for editing -- the
    // seeding logic itself is unchanged by this correction. ---
    assert.match(component, /initial\?\.commitmentDurationMonths != null && !initialDurationIsPreset \? String\(initial\.commitmentDurationMonths\) : ""/, "an existing non-preset duration must still seed the custom input with its exact stored value");

    // --- Preset selections remain functional: choosing a preset never
    // routes through validateCustomDurationInput at all (durationChoice
    // !== "custom"), so isCustomDurationInvalid is always false for a
    // preset choice -- confirmed structurally: the validation call is
    // gated on durationChoice === "custom". ---
    assert.match(component, /durationChoice === "custom" \? validateCustomDurationInput\(customDuration\) : null/, "preset/'Not set' choices must never be run through the custom-duration validator at all");
  }

  console.log("pledge-payment-plan-custom-duration: ok");
}

await run();
