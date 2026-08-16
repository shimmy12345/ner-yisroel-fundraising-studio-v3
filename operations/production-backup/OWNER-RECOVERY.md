# Fundraising OS owner recovery guide

This is the one-page recovery process for the approved owner. Production is private; do not send backups through email or place plaintext exports in shared folders.

## Routine protection

Backups are now **automatic** — see docs/DEPLOYMENT.md's "Automated D1
backup (GitHub Actions + R2)" section for the full architecture. Nothing
below requires the owner to remember to run anything on a schedule.

1. **Nightly, automatically:** a GitHub Actions workflow exports the
   entire `fundraising-os-staging-db`, encrypts it, and uploads it to a
   dedicated R2 bucket the deployed application itself cannot read, write,
   or delete from. Retention: 90 days of daily backups (R2 lifecycle rule
   on the bucket, comfortably above the 60-day minimum), plus a
   never-expiring `latest/` pointer.
2. **Monthly, automatically:** a second GitHub Actions workflow restores
   the latest backup into a throwaway D1 database, runs a full integrity
   and schema check, and deletes the scratch database — proving the
   backup is actually restorable, not just that the export step succeeded.
   Check the Actions tab for this repository if you want to confirm the
   last run's result.
3. **A pre-2026-08-16 manual export exists and predates this pipeline:**
   `staging-before-real-import-2026-08-06.sql`, taken by hand with
   `wrangler d1 export` before the first real donor data was imported. It
   was never recorded in `workspace_backup_audits` because that table only
   logs `/api/import/backup` (the in-app, partial-export route) — a manual
   `wrangler d1 export` doesn't touch the app at all. Do not read
   `workspace_backup_audits` being empty as "no backup has ever existed";
   read it as "the in-app export route has never been used." Keep that
   file wherever it was originally saved, alongside (not instead of) the
   automated R2 backups.
4. **Do not rely on `Settings → Download partial workspace export`** for
   real protection — it is explicitly a partial, human-readable export
   (see `lib/operations/workspace-backup.ts` for exactly which tables it
   omits), useful for a quick look, not a backup. The automated pipeline
   above is the actual backup.
5. If the automated pipeline is ever disabled or the Cloudflare/GitHub
   setup it depends on changes, fall back to the manual procedure it
   replaced: `wrangler d1 export --remote`, encrypt with
   `protect-backup.ps1` using the organization's public recovery
   certificate, store the `.p7m` file and its manifest outside the Worker
   project in an owner-only backup location, and rehearse a restore
   monthly until automation is restored.

## Recovery

1. **Stop writes.** Tell users to stop imports, merges, captures, and repairs. If access may be compromised, remove all non-owner access before doing anything else.
2. **Take a current bookmark.** Record the deployed commit, Data Health result, incident time, and latest encrypted backup manifest. If D1 is reachable, take one additional backup before restoring.
3. **Restore safely.** Decrypt a copy with `restore-encrypted-backup.ps1`. Rehearse it first with `pnpm db:production:restore-rehearse -- <backup.sql>`. Restore into a new recovery database; never overwrite the only production copy before verification.
4. **Verify integrity.** Require schema 0019, matching schema hash, `PRAGMA integrity_check = ok`, no foreign-key failures, no duplicate active JL Codes, no orphaned gifts/interactions/reminders/payments, and reconciled giving totals.
5. **Reopen access.** Point production to the verified recovery database, restore only the approved owner policy, run `/health`, then reopen writes. Keep the damaged database and incident notes until the owner signs off.

## Stop conditions and edge cases

- **Corrupt or incomplete backup:** checksum, decryption, schema, or integrity failure means stop and use the preceding known-good backup.
- **Wrong environment:** confirm the project name and D1 binding say Production before restore. Never restore into staging or copy staging data as a shortcut.
- **Compromised owner account or lost recovery key:** keep production closed. Recover the owner identity or offline private key through organizational administration; never create a bypass token or weaken access to get around the incident.
