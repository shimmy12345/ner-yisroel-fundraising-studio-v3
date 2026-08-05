# Fundraising OS owner recovery guide

This is the one-page recovery process for the approved owner. Production is private; do not send backups through email or place plaintext exports in shared folders.

## Routine protection

1. **Before the first import:** open the private production `/health` page and choose **Download schema-only production backup**.
2. **After real data exists:** use Settings → **Download current D1 backup** after every import or merge session and at least weekly.
3. Encrypt every downloaded `.sql` or `.json` with `protect-backup.ps1`, using the organization’s public recovery certificate. Store the `.p7m` file and its manifest outside the Worker project in an owner-only backup location. Keep the private recovery key offline with a second authorized custodian.
4. Retain eight weekly backups and twelve month-end backups. Rehearse one restore monthly and record the date and checksum. Never delete the last known-good backup after a failed export.

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
