# Foundation architecture

Status: accepted for Milestone 1

## Decisions

- Use the Vinext/Next.js application model with React and strict TypeScript for
  server rendering, route-level composition, accessibility, and Cloudflare
  Worker deployment.
- Use platform-provided identity headers and dispatch-owned sign-in. The app
  will not own credentials or session infrastructure.
- Store relationship data in D1 through Drizzle. Route handlers and server
  components access persistence through `db/index.ts`; UI components never
  access a runtime binding directly.
- Keep AI providers behind the `AIService` interface. Every AI result must carry
  rationale, confidence, and source identifiers so recommendations remain
  explainable and auditable. This metadata may be retained internally for
  auditability; confidence scores and other technical AI metadata should not
  be surfaced to fundraisers unless explicitly requested or operationally
  necessary.
- Treat Today as a read model assembled from donors, interactions, gifts,
  recommendations, and calendar sources. Ranking logic remains outside visual
  components.
- Emit structured JSON logs and return calm, recovery-oriented error states to
  the user.

## Deferred decisions

- External calendar, email, and gift-system connectors.
- Production AI provider, model routing, prompt evaluation, and retention policy.
- Organization roles and fine-grained authorization.
- Ranking weights and fundraiser controls for recommendation feedback.
