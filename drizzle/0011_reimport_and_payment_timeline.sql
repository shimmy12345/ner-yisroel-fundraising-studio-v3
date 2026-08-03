DROP INDEX `data_imports_user_file_hash_unique`;
--> statement-breakpoint
UPDATE `data_imports` SET `status` = 'undone' WHERE `status` = 'rolled_back';
--> statement-breakpoint
CREATE INDEX `data_imports_user_file_hash_status_idx` ON `data_imports` (`user_id`,`file_hash`,`status`);
--> statement-breakpoint
ALTER TABLE `jl_payment_assignment_audits` ADD COLUMN `payment_date` integer;
--> statement-breakpoint
ALTER TABLE `jl_payment_assignment_audits` ADD COLUMN `remaining_balance_cents` integer;
--> statement-breakpoint
UPDATE `jl_payment_assignment_audits`
SET `remaining_balance_cents` = `next_balance_cents`
WHERE `decision_type` = 'apply_to_pledge';
