-- Financial records represent calendar dates. Strip legacy time components
-- without touching monetary values, ownership, fingerprints, or linked ids.
UPDATE `giving_activities`
SET `activity_date` = CAST(`activity_date` / 86400 AS INTEGER) * 86400
WHERE `activity_date` IS NOT NULL
  AND `activity_date` != CAST(`activity_date` / 86400 AS INTEGER) * 86400;

UPDATE `gifts`
SET `received_at` = CAST(`received_at` / 86400 AS INTEGER) * 86400
WHERE `received_at` IS NOT NULL
  AND `received_at` != CAST(`received_at` / 86400 AS INTEGER) * 86400;

UPDATE `jl_payment_assignment_audits`
SET `payment_date` = CAST(`payment_date` / 86400 AS INTEGER) * 86400
WHERE `payment_date` IS NOT NULL
  AND `payment_date` != CAST(`payment_date` / 86400 AS INTEGER) * 86400;
