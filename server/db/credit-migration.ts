export const creditMigration = `
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM lad_migrations WHERE version=12) THEN
  ALTER TABLE accounts ADD COLUMN credit_settings jsonb NOT NULL DEFAULT '{"limit":"0","minimumPayment":"0","paymentDay":20,"graceUntil":null,"payerAccountId":null,"payFull":true}';
  ALTER TABLE obligations ADD COLUMN bank_schedule jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE obligations ADD COLUMN interest_method text NOT NULL DEFAULT 'monthly';
  ALTER TABLE plans ADD COLUMN custom_dates jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE plan_versions ADD COLUMN custom_dates jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE plans DROP CONSTRAINT plans_frequency_check;
  ALTER TABLE plans ADD CONSTRAINT plans_frequency_check CHECK (frequency IN ('once','monthly','weekly','yearly','custom'));
  ALTER TABLE plan_versions DROP CONSTRAINT plan_versions_frequency_check;
  ALTER TABLE plan_versions ADD CONSTRAINT plan_versions_frequency_check CHECK (frequency IN ('once','monthly','weekly','yearly','custom'));
  ALTER TABLE plans DROP CONSTRAINT plans_source_check;
  ALTER TABLE plans ADD CONSTRAINT plans_source_check CHECK (source IN ('manual','obligation','goal','credit'));
  INSERT INTO lad_migrations(version)VALUES(12);
 END IF;
END $$;
`
