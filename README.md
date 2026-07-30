# Fundraising OS

Fundraising OS is an AI-powered relationship workspace for professional
fundraisers. It helps a fundraiser understand who deserves attention today,
prepare for donor conversations, and act with context.

## Milestone 1

The foundation includes:

- a responsive application shell with Today, Donors, and Assistant;
- a polished Today preview and sample relationship workspace;
- platform-provided identity helpers;
- a D1/Drizzle relationship data model and seed data;
- an explainable AI service boundary;
- structured logging, recovery-oriented error handling, and health checks;
- focused foundation tests and a production deployment build.

## Development

Requirements: Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm dev
pnpm test
pnpm build
```

Architecture decisions are documented in `docs/architecture`.
