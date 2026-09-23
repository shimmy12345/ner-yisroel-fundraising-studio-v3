-- Giving Import -- Third-Party Source Attribution (see
-- docs/AI-HANDOFF.md and lib/import/donor-source-attribution.ts).
-- Hand-authored, per this repo's established convention: drizzle-kit's
-- own generate journal has been stale since migration 0014 and is not
-- trusted (confirmed again this round -- running it produced a bogus
-- full-schema dump treating every existing table as new, discarded
-- before anything was written). Purely additive: one new CREATE TABLE,
-- two new indexes, and two new nullable columns on an existing table --
-- zero ALTER/rebuild of any column that already exists.
--
-- Product context: a JL source code (e.g. "22297", Price Waterhouse
-- Foundation) that commonly, but not always, represents a specific
-- donor's own fundraising relationship (e.g. Eitan Pfeiffer, JL 48637).
-- This table stores ONLY a SUGGESTION the import review UI surfaces as
-- a one-click "Attribute to <donor>" choice -- it is never consulted to
-- auto-attribute anything; every transaction still requires an explicit,
-- per-row human decision (see lib/import/jl-donation-rejection-review.ts
-- and lib/import/jl-payment-assignment.ts). suggested_donor_id is
-- deliberately a SEPARATE concept from a donor's own JL external_id/
-- donor_code: writing the source code there instead would make every
-- transaction under that code auto-match the donor globally, which is
-- exactly the false-equivalence this table exists to avoid (Price
-- Waterhouse Foundation and Eitan Pfeiffer remain two distinct
-- identities; this is transaction attribution, not identity merging).
CREATE TABLE `donor_source_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`external_source` text NOT NULL,
	`source_external_id` text NOT NULL,
	`source_name` text,
	`suggested_donor_id` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `donor_source_attributions_source_idx` ON `donor_source_attributions` (`user_id`,`external_source`,`source_external_id`);
--> statement-breakpoint
CREATE INDEX `donor_source_attributions_donor_idx` ON `donor_source_attributions` (`suggested_donor_id`);
--> statement-breakpoint
-- Populated ONLY when a payment's own JL source code did not match the
-- attributed donor_id's own household (i.e. an explicit third-party
-- attribution occurred) -- null for every ordinary payment. This is the
-- only durable, human-readable record of the original source payer for
-- an "apply_to_pledge" outcome, since that path never creates a new
-- giving_activities row of its own (only source_fingerprint, an opaque
-- hash, would otherwise survive).
ALTER TABLE `jl_payment_assignment_audits` ADD `source_external_id` text;
--> statement-breakpoint
ALTER TABLE `jl_payment_assignment_audits` ADD `source_name` text;
