# Production database baseline

Production environment: **Fundraising OS Production** (`fundraising-os-production`). It uses a Sites project and D1 database that are distinct from staging. The normal `pnpm build` remains the staging build; only `pnpm build:production` packages this baseline and the production project configuration.

This folder is the clean starting point for a brand-new Fundraising OS production database. It contains the complete application schema through version 0019 and no donor, gift, interaction, reminder, sample, or test data.

The existing staging database is intentionally treated as a legacy database. Never apply this baseline to staging and never mark staging migrations as verified.

Before a production launch:

1. Run `pnpm db:baseline:rehearse`. It must report integrity OK, an empty workspace, and replay protection.
2. Confirm Settings → Data Health reports that staging and the production baseline have matching tables, columns, indexes, and constraints.
3. Create a brand-new production Sites project with a brand-new D1 database.
4. Set the build-time schema track to `FUNDRAISING_OS_SCHEMA_TRACK=production-baseline` for that production project only.
5. Deploy once. The baseline marker must report version 0019 and the stored schema hash must match `schema-manifest.json`.
6. Do not copy staging data until backup, restore, and data-migration rehearsals are separately approved.

If any check differs, stop the launch. Do not edit D1 metadata or replay legacy migrations to force a green result.

Operational safeguards:

- A production build stops if the production and staging project IDs ever match.
- Reapplying the baseline stops on existing tables rather than guessing what ran.
- A future migration requires regenerating the manifest and passing the drift test before production packaging succeeds.
- The authenticated health endpoint is read-only, so checking a new database does not create a user record.
