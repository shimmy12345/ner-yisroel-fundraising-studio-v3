ALTER TABLE `giving_activities` ADD COLUMN `record_origin` text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
UPDATE `giving_activities` SET `record_origin` = 'verification' WHERE `external_source` = 'JL Solutions' AND `source_campaign` = 'CODEX-VERIFY-49db8e2';
--> statement-breakpoint
UPDATE `giving_activities` SET `record_origin` = 'sample' WHERE `donor_id` IN (SELECT `id` FROM `donors` WHERE `data_source` = 'sample');
--> statement-breakpoint
CREATE INDEX `giving_activities_owner_origin_date_idx` ON `giving_activities` (`owner_user_id`,`record_origin`,`activity_date`);
