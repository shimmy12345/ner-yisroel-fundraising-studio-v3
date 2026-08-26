import assert from "node:assert/strict";
import { renderAgendaHtml, renderAgendaText } from "../lib/agenda/agenda-render.ts";

function item(overrides) {
  return {
    key: "item-1",
    donorId: "donor-1",
    donorName: "Mr. & Mrs. Cohen",
    donorCode: "1",
    headline: "Follow up",
    context: "Due today",
    href: "https://fundraising-os-staging.sgoldstein.workers.dev/donors/donor-1",
    ...overrides,
  };
}

function agenda(overrides) {
  return {
    subject: "Fundraising Agenda — Wednesday, August 26",
    dateLabel: "Wednesday, August 26",
    generatedAt: 0,
    todayPriorities: [],
    overdue: [],
    importantDates: [],
    suggested: [],
    isEmpty: true,
    ...overrides,
  };
}

async function run() {
  // --- Empty-agenda rendering: a clear, friendly message, no bare/blank
  // sections, in both HTML and plain text. ---
  {
    const empty = agenda();
    const text = renderAgendaText(empty);
    assert.match(text, /Fundraising Agenda — Wednesday, August 26/);
    assert.match(text, /Nothing due, overdue, or scheduled today/);
    assert.doesNotMatch(text, /TODAY'S PRIORITIES/, "an empty section header must not print with nothing under it");

    const html = renderAgendaHtml(empty);
    assert.match(html, /Nothing due, overdue, or scheduled today/);
    assert.doesNotMatch(html, /TODAY&#39;S PRIORITIES/);
  }

  // --- Section presence: only non-empty sections render, in the fixed
  // TODAY'S PRIORITIES / OVERDUE / IMPORTANT DATES / SUGGESTED order --
  // and a section with items never gets the empty-agenda message. ---
  {
    const populated = agenda({
      isEmpty: false,
      todayPriorities: [item({ headline: "Call about pledge" })],
      suggested: [item({ headline: "Reach out", context: "It's been 45 days." })],
    });
    const text = renderAgendaText(populated);
    assert.match(text, /TODAY'S PRIORITIES/);
    assert.match(text, /SUGGESTED/);
    assert.doesNotMatch(text, /^OVERDUE$/m, "OVERDUE must not appear when empty");
    assert.doesNotMatch(text, /IMPORTANT DATES \/ STEWARDSHIP/, "Important Dates must not appear when empty");
    assert.ok(text.indexOf("TODAY'S PRIORITIES") < text.indexOf("SUGGESTED"), "sections render in the fixed order even when some are skipped");
    assert.doesNotMatch(text, /Nothing due, overdue, or scheduled today/);

    const html = renderAgendaHtml(populated);
    assert.match(html, /TODAY&#39;S PRIORITIES/, "the apostrophe is HTML-escaped, correctly, in the heading too");
    assert.match(html, /SUGGESTED/);
    assert.doesNotMatch(html, />OVERDUE</);
  }

  // --- HTML escaping: a donor name/context/headline containing HTML
  // metacharacters must never break out of its element or inject markup. ---
  {
    const dangerous = agenda({
      isEmpty: false,
      overdue: [
        item({
          donorName: "Cohen <script>alert(1)</script> & Sons",
          headline: 'Follow up on "the ask" <b>now</b>',
          context: "Balance > $500 & rising",
          href: "https://fundraising-os-staging.sgoldstein.workers.dev/donors/donor-1?x=1&y=2",
        }),
      ],
    });
    const html = renderAgendaHtml(dangerous);
    assert.doesNotMatch(html, /<script>/, "a raw <script> tag must never appear unescaped in the rendered HTML");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /Cohen .* &amp; Sons/);
    assert.match(html, /&quot;the ask&quot; &lt;b&gt;now&lt;\/b&gt;/);
    assert.match(html, /Balance &gt; \$500 &amp; rising/);
    // The href itself is also escaped as HTML attribute content (its own
    // "&" must become "&amp;" inside the attribute), while remaining a
    // usable link.
    assert.match(html, /href="https:\/\/fundraising-os-staging\.sgoldstein\.workers\.dev\/donors\/donor-1\?x=1&amp;y=2"/);
  }

  // --- Every item links back to the app -- "direct links to the
  // relevant donor/Ask" -- in both renderings. ---
  {
    const populated = agenda({ isEmpty: false, overdue: [item()] });
    assert.match(renderAgendaHtml(populated), /href="https:\/\/fundraising-os-staging\.sgoldstein\.workers\.dev\/donors\/donor-1"/);
    assert.match(renderAgendaText(populated), /https:\/\/fundraising-os-staging\.sgoldstein\.workers\.dev\/donors\/donor-1/);
  }

  // --- An item with no context (headline says everything) renders
  // cleanly with no stray empty context line/element. ---
  {
    const noContext = agenda({ isEmpty: false, suggested: [item({ context: null, headline: "Mother's yahrtzeit today" })] });
    const text = renderAgendaText(noContext);
    assert.match(text, /Mr\. & Mrs\. Cohen: Mother's yahrtzeit today/);
    // No lone blank "context" line directly between the headline and the link.
    assert.doesNotMatch(text, /Mother's yahrtzeit today\n  \n/);
  }

  console.log("agenda-render: all assertions passed");
}

await run();
