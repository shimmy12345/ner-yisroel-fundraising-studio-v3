# Fundraising OS — Product & Engineering Principles

This document is the standing reference for anyone (human or agent) making
changes to Fundraising OS. It does not describe how the code currently works
— read the code for that — it describes the rules a change must not break.

## Product purpose

- Fundraising OS is a daily relationship and workflow layer for a fundraiser.
- JL Solutions remains the financial system of record.
- Fundraising OS is **not** a full CRM, accounting system, receipting system,
  payment processor, or campaign-management platform.
- The application should help answer:
  - What should I do today?
  - What do I need to know about this donor?
  - What happened, and what should happen next?

## Data and trust rules

- Never fabricate donor facts, summaries, subjects, research, or
  recommendations.
- If information is missing, show an honest empty state.
- All live data must be owner-scoped.
- Sample/test data must never appear in live workspace mode.
- Never silently merge donors.
- Never silently overwrite local contact overrides.
- Imported financial records must not be hard-deleted.
- Important user actions should be reversible where practical.
- Preserve audit history.
- Financial records use calendar dates only, with no timezone shifting and no
  displayed time.
- Calls, meetings, reminders, and scheduled activities may use date and time.
- JL Code should remain visible wherever donor identity is shown.
- Avatar initials should use the primary contact's first and last initials,
  ignoring honorifics.

## Import rules

- Household and donation imports require preview before writes.
- Existing donor review behavior must respect the user's configured review
  mode.
- Duplicate and conflict decisions must be explicit.
- Review Later writes nothing.
- Pledge payments may be manually assigned to any open pledge for that donor.
- Import undo must be batch-scoped and must never guess when rollback
  evidence is incomplete.
- Staging and production must use separate Workers and D1 databases.

## AI rules

- AI should be invisible unless it adds clear fundraising value.
- Never save AI-generated content without explicit user acceptance.
- Do not expose confidence scores, sentiment classifications, extraction
  status, or technical AI language unless specifically requested.
- Rule-based behavior must not be mislabeled as AI.
- Relationship summaries should be actionable, evidence-based, and concise.

## UX rules

- The interface should feel calm, clear, and action-oriented.
- The homepage should answer "What should I do next?"
- Quick Actions and Morning Brief should be visible near the top.
- Empty states should collapse instead of consuming large amounts of space.
- Prefer fundraiser language over technical language.
- Common workflows should require as few clicks as practical.
- Search, back navigation, filters, and scroll position should behave
  predictably.
- Do not add unrelated redesigns during focused tasks.

## Engineering rules

- Inspect the existing implementation before changing code.
- Prefer improving existing code over replacing it.
- Minimize files changed.
- Preserve working behavior unless the task explicitly changes it.
- Do not modify public `main`; it contains the old CRM.
- Independent Staging development happens on whichever branch is currently
  ahead — verify this with `git fetch` plus `git rev-parse`/`git log` and
  against `docs/AI-HANDOFF.md`'s "Current Git State" section before starting
  work, rather than trusting a branch name recorded in this document or any
  other historical note. As of 2026-08-20, that branch is
  `feature/independent-cloudflare-sandbox`: `feature/fundraising-os-redesign`
  is the branch this application's foundation was originally built on, but
  `feature/independent-cloudflare-sandbox` forked from its tip on 2026-08-05
  and has continued alone since (proven by `git merge-base`: it contains
  every commit `feature/fundraising-os-redesign` has, plus 100+ more, while
  `feature/fundraising-os-redesign` has zero commits the other branch
  lacks). Treat `feature/fundraising-os-redesign` as a historical/superseded
  branch, not a second active target — do not delete, merge, or rewrite it
  without explicit approval, since its actual disposition (kept for
  reference vs. safe to retire) has not been decided.
- A branch name recorded in this document, `CLAUDE.md`, or
  `docs/AI-HANDOFF.md` is a starting hint, never authoritative on its own.
  When it conflicts with verified current git/deployment state or the
  user's explicit task instruction, the verified state and the user's
  instruction win — surface the conflict and correct the stale note rather
  than silently guessing or silently overriding it.
- A separate private Sites source repository may have its own `main`; always
  identify the remote before pushing.
- Do not change production data, bindings, migrations, or access policies
  without explicit approval.
- Never weaken data-integrity, authentication, backup, or launch safeguards.
- If a fact cannot be verified, say so instead of guessing.
- Run tests, type check, and production build before declaring
  implementation complete when the environment supports them.
- Never claim tests or deployment succeeded if they were not run.
- Deploy to staging only after explicit approval.
- Production deployment always requires separate explicit approval.

## Task sizing

For data integrity, imports, merges, authentication, backups, or migrations:
- explain the root cause;
- identify realistic edge cases;
- add regression tests.

For small UI polish:
- keep scope narrow;
- verify only the affected workflow;
- do not over-engineer.

## Standard completion report

Every completed task should report:

1. Root cause
2. Files changed
3. Verification performed
4. Remaining risks
5. Staging status
6. Commit SHA
