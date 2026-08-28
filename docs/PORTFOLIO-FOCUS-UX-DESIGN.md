# Portfolio Focus — UX Investigation and Design (Phase 2)

**Interactive mockup:** `docs/portfolio-focus-mockups/portfolio-focus-ux.html`
(also delivered to the user directly). Four switchable screens — Today
page, dedicated view, "why this donor?" detail, mobile — built with real
Phase 1 engine output, styled with the real Fundraising OS visual
tokens (extracted live from Independent Staging, not invented).

**Status:** investigation/design only. No application code, UI, scoring,
Recommendation Engine, or Relationship Intelligence was changed. No data
was mutated. Nothing was deployed.

---

## 1. Executive recommendation

**Architecture: Option A** — a compact, 5-donor Portfolio Focus section
on the Today page, plus a dedicated Portfolio Focus view for depth.
Neither surface duplicates Suggested Actions; each answers a genuinely
different question, and the interface says so explicitly wherever a
donor happens to appear in both.

- **Today page:** 5 donors, no visible scores, one line of "why" each,
  placed as a new full-width section directly below the existing
  Today's Agenda / Coming Up row (that row is untouched).
- **Dedicated view:** the calibrated Top 25 shown by default, rank-
  ordered, with an expandable "show full portfolio" control reaching all
  248. Filter chips by attention type; no forced grouping.
- **Raw composite/component scores: hidden from default UI everywhere.**
  Available only behind an explicit "show technical detail" disclosure
  in the expanded explanation, translated everywhere else into plain
  language.
- **Daily Agenda: defer.** Do not add Portfolio Focus to the email yet
  (Section 12).
- **Donor page integration: recommended, small.** A single line near
  Relationship Snapshot, not a duplicate ranking (Section 10).
- **Assistant integration: recommended, design-only.** The Assistant
  should call the same engine, never reconstruct strategic reasoning
  itself (Section 11).

---

## 2. Current-product UX audit

Inspected live against Independent Staging (`https://fundraising-os-
staging.sgoldstein.workers.dev`), not from memory. Computed styles
extracted directly from the rendered page.

**Visual language (real values, not approximations):**
- Paper background `#f8f7f2`; card background `#ffffff`; hairline
  borders `#e4e6df`.
- Ink `#25352f`; muted text `#6f7c76`/`#87918b`; badge text `#7a8580`.
- Accent green `#135c45` (brand mark, links); a slightly lighter
  `#316c54` used specifically as the 2.5px top-border accent on
  "primary" Today cards (Today's Agenda, Morning Brief).
- Headings: Georgia serif, weight 500. Body/UI: a system sans stack
  (rendered as "Geist" in the deployed app, which is not available via
  Google Fonts — the mockup uses an equivalent system-sans stack rather
  than substituting a different characterful typeface, since fidelity to
  the real product matters more here than typographic novelty).
- Small "eyebrow" section labels: 11px, weight 680, letter-spacing
  1.5px, uppercase, `#87918b`.
- Pills/badges (e.g., "Birthday" on Coming Up): background `#f0f2ef`,
  radius 10px, padding 3px/6px, 10px/650-weight text, color `#7a8580`.
- Cards: white, 1px `#e4e6df` border, 14px radius, ~19px padding.

**Today page, current structure (top to bottom):** greeting header →
Morning Brief (accent-top card) → Quick Actions (4-tile grid) → a
two-column row: **Today's Agenda** (left, flexible width, accent-top) /
**Coming Up** (right, capped ~480px, bounded/scrollable body) — this
exact pairing and width balance is the recently-approved desktop layout
cleanup and is **not touched** by any recommendation in this document.

**Donor page:** a 4-column stat strip (Lifetime Paid / Most Recent Paid
Gift / Open Commitments / Suggested Action) using large serif numbers
under small eyebrow labels, followed by Asks, Relationship Snapshot
("Prepare for the next interaction" heading + synthesized text +
Suggested Action sub-card), Household, Contact, and timeline sections.
**No numeric score of any kind is shown anywhere in the current
product** — this is a real, existing precedent for keeping Portfolio
Focus's own composite score out of the UI (Section 5).

**Space/density:** Today is already a stack of substantial cards; there
is no free horizontal real estate for a fifth wide column without
narrowing Today's Agenda or Coming Up, which would regress the recent
cleanup. There is comfortable room for **one new full-width section
below** the existing row.

---

## 3. Strategic vs. tactical UX principles

1. **Different verbs, never the same list shape.** Suggested Actions
   items read as verbs-with-objects ("Follow up on pledge," "Send a
   thank-you"). Portfolio Focus items read as **relationships with a
   category of attention** ("Cultivate & Steward," "Relationship
   Review") — never phrased as a single imperative task, so the two
   never visually collapse into duplicate to-do lists.
2. **Portfolio Focus never invents an action.** If the real Suggested
   Actions system has a live recommendation for a donor, Portfolio Focus
   surfaces its existence (a small icon/flag, Section 8) and links to
   it — it never writes its own paraphrase of what to do.
3. **Coverage-driven presence is explicitly not a call to solicit.**
   Every coverage-triggered donor's badge and copy read as a request to
   *learn*, never to *ask* (Section 9) — this is the single most
   important UX guardrail in this whole design, because it is the
   surface where a careless label ("Yale Miller — action needed") would
   actively mislead a fundraiser into an unsolicited, capacity-unverified
   ask.
4. **The score is infrastructure, not content.** The composite exists so
   the engine can rank; the *reason* is the product. See Section 5.

---

## 4. Options considered

| | **A. Top 5 on Today + dedicated view** | **B. Dedicated page only** | **C. Larger panel on Today** | **D. Fold into an existing surface** |
|---|---|---|---|---|
| Clarity | High — a short, labeled list is instantly scannable | High on the page itself, but invisible unless the fundraiser navigates there daily | Medium — a bigger panel starts to compete visually with Today's Agenda | Low — donors would need to infer strategic intent from a surface built for something else |
| Daily usefulness | High — surfaces automatically every morning | Low unless visited deliberately; strategic orientation is easy to forget to check | High, but at the cost of Today's own focus | Depends entirely on the host surface's own traffic |
| Cognitive load | Low (5 items, one line each) | Low on its own page, but a second destination to remember | Higher — more rows, more risk of becoming a second task list | Risk of conflating two mental models on one surface |
| Duplication w/ Suggested Actions | Low — different labels, different framing, explicit acknowledgment | Low | Medium — a larger table starts to look like a second Suggested Actions | High risk if folded into the Suggested Actions/queue surface itself |
| Desktop fit | Good — one new section under the existing row, no regression | N/A (own page) | Requires narrowing existing columns or pushing content down aggressively | Depends on host |
| Mobile fit | Good — already a simple vertical list | Good on its own page | Same list, just bigger — no added mobile cost, but same desktop cost | Depends on host |
| Explainability | Full — dedicated view carries the deep "why" | Full | Full | Constrained by the host surface's own explanation model |
| Implementation complexity | Medium (two surfaces) | Lower (one surface) | Low-medium (one surface, but layout risk) | Low code, high product-risk |

**Verdict: A.** B alone fails "daily usefulness" — strategic orientation
that requires a deliberate visit will be forgotten exactly on the days
it matters most (a busy morning). C risks turning Today into two
competing task lists, the one failure mode the product brief explicitly
warns against. D risks the same conflation at a structural level. A
gets the daily-visibility benefit of a Today presence without any of
C's crowding, because it is capped at 5 items and demoted below the
existing action row.

---

## 5. Recommended Today-page design

**Placement:** a new, full-width section directly **below** the
existing Today's Agenda / Coming Up row (Screen A of the mockup). This
follows the working hierarchy hypothesis (immediate work first,
strategic orientation second) while making zero changes to the
already-approved row above it — the safest possible placement given the
explicit "do not regress the layout cleanup" constraint.

**Header treatment:** eyebrow "This Month" + serif heading "Portfolio
Focus" + a one-line subhead ("Five relationships worth keeping in mind
this month, independent of today's scheduled work") + a quiet "See full
portfolio →" link to the dedicated view. The accent-top border uses a
distinct hue (a muted olive/sage in the mockup, `#8a9a5b`) rather than
reusing Today's Agenda's own green accent — close enough to belong to
the same family, different enough that a fundraiser never mistakes it
for another "today" action list at a glance.

**Row shape, per donor:** rank number (quiet, serif, small) · donor
name + code · one attention-type badge · one line of "why now" · a
"View →" link to the donor. **No score, no component breakdown, no
percentage.**

**Count: 5, confirmed against the real layout, not merely the working
hypothesis.** Tested 3 vs. 5 vs. 7 in the mockup: 3 felt thin relative
to the vertical weight of the cards above it; 7 began to visually rival
Today's Agenda's own height, working against the "orientation layer,
not a second worklist" goal. 5 matches the card's natural height against
its neighbors and mirrors Coming Up's own typical visible-row count.

---

## 6. Recommended dedicated Portfolio Focus view

**Default scope: the calibrated Top 25**, rank-ordered, exactly as
Phase 1 computes it — not a curated or re-sorted subset. An "Show full
portfolio (248 relationships, ranked)" control at the bottom expands to
the complete list. This directly serves the "which strategically
important relationships have poor documentation" use case (Question 9,
Section 14), which can require scanning past 25 in a smaller
Coverage-heavy portfolio segment.

**Filter chips** (Section 14): All Focus Relationships (default) ·
Solicitation Opportunity · Cultivate & Steward · Relationship Review ·
Reconnect · a secondary toggle for "Suggested Action available." Chips
narrow the same ranked list; they never re-group it into sections — no
artificial "3 of each type" quota, consistent with the calibration's own
principle that the evidence, not a target shape, decides the list.

**Row (default, collapsed):** rank · donor name/code · attention badge ·
one-line "why now" · a confidence dot (Section 16) · a small flag icon
if a real Suggested Action exists (Section 8) — six columns, no more.

**Expanded (row tap/click):** opens the "Why is this donor here?"
experience in place (Section 7) rather than navigating away — keeps the
fundraiser in the ranked list.

**What stays hidden even in expanded detail, unless "show technical
detail" is opened:** the five raw component decimals, the raw Coverage/
floor values, the internal momentum-label and stale-balance enum
values. These are real, useful numbers for debugging and for a future
power-user/admin view, but Round 3's own report is explicit that the
model's job is to *produce* a ranking, not to *teach* fundraisers a
formula.

---

## 7. "Why is this donor here?" design

Structure (Screen C of the mockup), using Phase 1's real, already-
computed `whyNow` and `evidence` fields, reformatted for card reading —
**never new facts, only a presentation rewrite of the same evidence
object**:

1. **Lede sentence** — the `whyNow` string, lightly reformatted for a
   headline position (e.g. Miller's raw `whyNow`, "*$199,150 lifetime
   relationship with little or no documented interaction, Relationship
   Fact, or Ask history — Fundraising OS has limited visibility into
   what is currently happening here,*" becomes "*One of the largest
   lifetime relationships in the entire portfolio — $199,150 given over
   54 years — but Fundraising OS has almost no current relationship
   information on file. This is a request to learn more, not a signal
   to ask for money.*" — same facts, reordered for a card lede, with the
   explicit non-solicitation framing added because Coverage cases
   specifically need it stated, not implied).
2. **Four evidence tiles** (Financial Significance / Opportunity /
   Stewardship / Relationship Visibility), each one sentence, in
   fundraiser language:

   | Component | Miller (real) | Spetner (real) |
   |---|---|---|
   | Financial significance | "Among the most significant relationships in your portfolio ($199,150 lifetime, one of the largest single gifts on record)." | "A well-established relationship: $100,361 given over 31 years." |
   | Opportunity | "No current pledge or scheduled next step on file." | "This commitment was made about a year ago — not a new or emerging opportunity." |
   | Stewardship need | "No recent commitment or open reminder requiring active follow-through right now." | "An active pledge is being paid down on schedule: $2,000 remaining of $12,000, most recent payment 11 days ago." |
   | Relationship visibility | "No interaction, Relationship Fact, or Ask has ever been logged for this donor." | "No one-on-one interaction has been logged, though the pledge itself is well documented and on track." |

3. **Tactical cross-reference** (Section 8) — one line, always present:
   either "No urgent tactical action on file right now" or "Suggested
   Actions available: *[real action text]* →."
4. **Confidence line** (Section 16).
5. **`<details>` disclosure**, closed by default: "Show technical
   detail" reveals the five raw component values and the real momentum/
   Coverage/stale-balance internals, for the rare fundraiser (or the
   product team) who wants to audit the math.

---

## 8. Attention-type display language

Internal enum values (from `lib/portfolio-focus/attention-type.ts`) are
preserved exactly as-is in the data model; only DISPLAY text is
normalized, per instruction. Recommended mapping — six labels, the
smallest vocabulary that keeps every real distinction legible:

| Internal value | Display label | Badge color family |
|---|---|---|
| `solicit_scheduled` | **Solicitation Opportunity** | green-tinted |
| `cultivate_steward_active` | **Cultivate & Steward** | neutral gray-green |
| `steward_active_fulfillment` | **Active Stewardship** | blue-gray |
| `reconnect_understand_decline` | **Reconnect** | neutral gray-green |
| `cultivate_real_growth` | **Cultivate** | neutral gray-green |
| `learn_relationship_review` | **Relationship Review** | warm tan |
| `coverage_needed` | **Relationship Review** *(same label as above — see below)* | warm tan |
| `monitor_routine` | *(not shown — never appears in a Top-25/Top-5 cut in practice)* | — |

**`learn_relationship_review` and `coverage_needed` intentionally share
one display label.** They are, from a fundraiser's point of view, the
same instruction ("go learn about this relationship, don't solicit it")
— the underlying distinction (a financially-significant-but-thin-
documentation read vs. a Coverage-floor-triggered read) stays real in
the data model and is visible in the `whyNow` text and the expanded
detail, but does not need two different badge words competing for
attention in a five-word vocabulary. This directly answers the
prompt's own suggestion (Section 6) that "Relationship coverage needed"
reads more naturally as "Relationship review."

---

## 9. Confidence / missing-context treatment

**Never a warning icon or red/amber alert color** — missing information
is not an error state (Round 3's own explicit principle, carried
through to the UI). Recommended: a small colored **dot**, not a badge,
paired with a short phrase, shown in the row (dedicated view) and
spelled out in the expanded detail:

- 🟢 **green dot, "Well documented"** — real interaction, fact, or Ask
  evidence exists.
- 🟡 **amber dot, "Financially clear, relationship thin"** — financial
  history is solid; relationship evidence is not.
- ⚪ **pale/gray dot, "Limited relationship context"** — the honest,
  neutral phrasing for the Miller/Schnaidman/Ray case: strategically
  important, but Fundraising OS doesn't know enough yet. Deliberately
  never "weak relationship" or "no relationship" — the dot's own color
  is a muted gray, not red, specifically so it never reads as a data
  problem.

The expanded detail always spells this out as a full sentence ("This
relationship appears financially significant, but Fundraising OS has
limited relationship information about it") rather than relying on the
dot alone to carry the meaning.

---

## 10. Donor-page integration recommendation

**Recommended, small, deferred to a later phase's implementation (not
built now).** A single, compact line — not a card, not a score, not a
mini-ranking — placed **directly above the Relationship Snapshot
section** (the natural "what does the system currently understand about
this person" zone), reading, e.g.:

> **Portfolio Focus:** Relationship Review — one of the portfolio's most
> significant relationships, limited current documentation. [See full
> reasoning →]

Rationale for exact placement: above Relationship Snapshot (not above
the financial stat strip, not inside Suggested Action) because it
answers a *relationship-level* strategic question, the same register as
the Snapshot itself, and it should visually introduce/contextualize the
Snapshot ("here's why this relationship matters this month") rather than
compete with the tactical Suggested Action card next to it. The link
opens the same "why this donor?" explanation used in the dedicated view
— never a second, donor-page-specific explanation implementation.

**A donor outside the current ranking window (e.g., rank #140 of 248)
shows nothing here at all** — this line should never say "not currently
a focus," which would read as a small, unnecessary judgment about every
other donor.

---

## 11. Assistant integration recommendation

**Design-only, matching the same architectural discipline Stage 1-3
already established for Meeting Brief → Assistant reuse:** the Assistant
should call `computePortfolioFocus()` directly for the specific
questions it's suited to (below), never reconstruct ranking/coverage
logic from raw donor rows itself.

| Prompt pattern | Recommended source |
|---|---|
| "Who should I focus on this week?" | Top N of `computePortfolioFocus()`, same as the dedicated view |
| "Which donors am I neglecting?" | Filter the same result set to `coverage_needed`/`learn_relationship_review` |
| "Who needs stewardship?" | Filter to `cultivate_steward_active`/`steward_active_fulfillment` |
| "Where should I spend my time?" | The same Top-N framing as the first question, phrased conversationally |

The Assistant's own response text should read the `whyNow`/evidence
fields the same way the UI does (Section 7's translation layer, reused,
not reimplemented a second time for chat) — never expose component
decimals in a conversational answer.

---

## 12. Daily Agenda recommendation

**Defer.** Do not add Portfolio Focus to the Daily Agenda email in this
phase or immediately after Today-page shipping. Reasoning: the email
already exists specifically for dated, near-term items (Suggested
Actions, scheduled activities, relationship dates); Portfolio Focus's
5-item Today section already serves the "see it every morning" need
once a fundraiser opens the app, and a *second* daily strategic list
delivered passively by email — before any usage data exists on whether
the Today section is even being read — risks training the fundraiser to
ignore one of the two redundant copies. Revisit after real Today-page
usage data exists (Investigation's own staged-plan discipline, applied
here).

---

## 13. Desktop / tablet / mobile behavior

- **Wide desktop / laptop:** as designed above — the Today section is a
  6-column row grid; the dedicated view is a 6-column row grid with a
  filter-chip row above it.
- **Tablet:** the dedicated view's "why now" column is the first to
  compress (wrap to two lines) as width narrows; the confidence-dot
  column collapses to the dot alone (no label text) below ~900px. No
  column is dropped outright until the mobile breakpoint.
- **Mobile:** **no table/grid row survives.** Today's 5-item section was
  already a simple vertical list and needs no transformation at all
  (Screen D, left phone). The dedicated view's row-grid becomes a
  **card stack** — rank + name + badge on one line, "why now" below it,
  tap-to-expand in place (an inline accordion, never a route change,
  never nested/inner scrolling — Screen D, right phone). Filter chips
  become a horizontally-scrollable single row (a common, already-
  acceptable mobile pattern, distinct from "nested scrolling" since it's
  a single control strip, not page content).

---

## 14. Real-donor examples used throughout

All wording above and in the mockup is drawn directly from the real
Phase 1 engine output verified in the Phase 1 implementation round
(`lib/portfolio-focus`, run against fresh Independent Staging data) —
no invented facts, no invented evidence. Ranks/scores are exactly as
computed; **no data has drifted since Phase 1's verification, since no
donor data or scoring code changed between that round and this one.**

| Donor | Rank | Attention (display) | Real `whyNow` (paraphrase basis) |
|---|---|---|---|
| Avi Stein | 1 | Cultivate & Steward | $75,000 commitment, 12 days old, currently active |
| Mordechai Schwartz | 2 | Cultivate & Steward | $36,000 commitment, 60 days old, currently active |
| Dovie Weinschneider | 3 | Solicitation Opportunity | Explicit scheduled follow-up ("Follow up on Giving follow-up") |
| Yaakov Zachter | 4 | Cultivate & Steward | $18,000 commitment, 71 days old, currently active |
| Eitan Zeffren | 5 | Solicitation Opportunity | Explicit scheduled follow-up ("Solicit corporate sponsorship for dinner") |
| Moishe Weber | 6 | Cultivate & Steward | $5,000 commitment, 11 days old, currently active (see Section 15 monitored-case note) |
| Shimmy Ramras | 7 | Relationship Review | $110,155 lifetime, limited current relationship documentation |
| Mordy Goldenberg | 8 | Cultivate | Real growth, $2,400 → $9,500 year-over-year |
| Yale Miller | 9 | Relationship Review | $199,150 lifetime, little or no documented interaction/fact/Ask |
| Dovid Weinberger | 10 | Cultivate & Steward | $1,800 commitment, 22 days old, currently active |
| Dov Zeffren | 11 | Relationship Review | $25,851 lifetime, limited current relationship documentation |
| Tzvi Ray | 12 | Relationship Review | $114,026 lifetime, little or no documented interaction/fact/Ask |
| Yehuda Moradian | 13 | Relationship Review | $37,708 lifetime, limited current relationship documentation |
| Manuel Schnaidman | 14 | Relationship Review | $158,202 lifetime, little or no documented interaction/fact/Ask |
| Yitzchak Sperka | 15 | Relationship Review | $54,837 lifetime, limited current relationship documentation |
| Jonathan Spetner | 16 | Active Stewardship | On-track pledge, $2,000 of $12,000 remaining, paid 11 days ago |

---

## 15. Wireframes / mockups

**`docs/portfolio-focus-mockups/portfolio-focus-ux.html`** — an
interactive, four-screen prototype (also delivered directly to the
user), built with the real extracted Fundraising OS visual tokens
(Section 2), not a new design system:

- **Screen A — Today page:** the current Today layout reproduced
  (Morning Brief, Quick Actions, the unchanged Today's Agenda/Coming Up
  row) with the new Portfolio Focus section beneath it, populated with
  the real rank-1-through-5 donors.
- **Screen B — Dedicated view:** the filter-chip row, the ranked table
  (ranks 1–16 shown), and the Moishe Weber monitored-case callout
  (Section 12's mandate: shown honestly, not hidden or special-cased).
- **Screen C — "Why this donor?":** a donor picker (Miller / Spetner /
  Weber, the three mandatory contrast cases) driving the full expanded-
  explanation layout, including the collapsed technical-detail
  disclosure.
- **Screen D — Mobile:** two phone frames at 375px width — Today's
  section (already a simple list) and the dedicated view collapsed to a
  tappable card stack.

---

## 16. Implementation sequence

| Phase | Scope | Files/surfaces likely affected | Data/query reuse | Perf impact | Testing | Independently deployable/verifiable? |
|---|---|---|---|---|---|---|
| **2A** | Today-page compact section | `app/page.tsx` (Today), a new small presentation component consuming `computePortfolioFocus()` | Calls the existing Phase 1 engine directly; Today's own loader (`live-data.ts`) is untouched — Portfolio Focus keeps its own separate query set (Phase 1 design) | +1 call to `computePortfolioFocus()` per Today render (12 batched queries, independent of donor count) — no change to Today's existing 19 | Component-level render test (5 rows render, correct badges/labels, no scores in DOM); visual regression check against the existing row below | Yes — additive section, easy to verify Today's existing content is byte-identical above the new section |
| **2B** | Dedicated Portfolio Focus page | New route (e.g. `app/portfolio-focus/page.tsx`), a ranked-list/table component, a filter-chip component | Same engine call, same result set as 2A (or a shared server-side cache of one call per request) | One `computePortfolioFocus()` call per page view | Route-level tests (filtering, expand-to-full-248, row → detail transition) | Yes — a wholly new route, zero interaction with existing pages |
| **2C** | Donor-page context line | `app/donors/[id]/page.tsx` | Needs the single donor's own `PortfolioFocusResult` — either look it up from a full portfolio computation (simplest, reuses 2B's shape) or add a single-donor accessor to `lib/portfolio-focus/index.ts` (a thin new export, no new scoring) | If reusing the full computation: same 12 queries, now also invoked from the donor page render — worth caching/memoizing per request if it also renders Today or the dedicated view in the same navigation | Test that a donor outside the ranking window renders nothing; a donor within it renders the correct line | Yes, but coordinate with 2A/2B's caching approach first to avoid tripling the query count per full user session |
| **2D** | Assistant integration | `app/api/assistant/route.ts`, the Assistant's own prompt-classification logic | Same engine, filtered result sets per prompt pattern (Section 11) | One additional `computePortfolioFocus()` call only for the relevant prompt patterns, not every Assistant request | New prompt-pattern tests mirroring the existing Assistant test conventions | Yes |
| **2E** | Daily Agenda evaluation | None yet — explicitly deferred (Section 12) | — | — | — | Revisit only after 2A ships and has real usage data |

**Sequence rationale:** 2A ships the highest-value, lowest-risk surface
first and is the one place real fundraiser reaction to the whole concept
(wording, count, placement) can be gathered before investing in 2B's
larger page. 2C and 2D both depend on 2A/2B's chosen data-access pattern
being settled first (to avoid three independent, redundant
`computePortfolioFocus()` call sites).

---

## 17. Risks / open questions

1. **Per-request computation cost if multiple surfaces call
   `computePortfolioFocus()` independently in one navigation** (e.g., a
   page that renders both Today's section and, hypothetically, a donor-
   page line in the same request). Phase 1's 12 batched queries are
   cheap once, but should not be invoked 2-3× per request once 2A-2C are
   all live — needs a request-scoped memoization decision during 2A/2B
   implementation, not resolved in this design pass.
2. **Moishe Weber's rank #6 remains a live, disclosed monitoring
   question**, not a UX problem to paper over (Section 12 mandate
   honored: the mockup shows him exactly as computed). If real
   fundraiser feedback says this is confusing, that is evidence for a
   future calibration round, not a signal to special-case him in the
   presentation layer.
3. **The `coverage_needed`/`learn_relationship_review` shared display
   label** (Section 8) trades a small amount of internal-model fidelity
   for vocabulary simplicity — worth revisiting if usage shows
   fundraisers want to distinguish "we truly know nothing" from
   "we know a little but not enough" at the badge level, not just in the
   why-text.
4. **Filter-chip "Suggested Action available" toggle** was proposed
   (Section 6/14) but not deeply designed — needs its own small pass
   once 2B is underway, particularly how it interacts with the other
   attention-type chips (AND vs. a separate secondary axis).
5. **Donor-page placement (Section 10)** assumes the Relationship
   Snapshot section is the right anchor; this should be sanity-checked
   against the real donor page's exact vertical rhythm during 2C
   implementation, not assumed to still be true if Relationship Snapshot
   itself changes shape before then.

---

**Stopping here, per explicit instruction — no implementation was
started.**
