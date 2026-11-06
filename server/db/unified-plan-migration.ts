// Iteration 4a: one plan model for every future income and payment.
// Recurring payment tables become plan tables; one-off calendar payments move into them.
// Complete and immutable once released: add later changes as a new version.
export const unifiedPlanMigration = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 6) THEN
    ALTER TABLE recurring_payments RENAME TO plans;
    ALTER TABLE plans ADD COLUMN direction text NOT NULL DEFAULT 'expense' CHECK (direction IN ('expense','income'));
    ALTER TABLE plans ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','obligation','goal'));
    ALTER TABLE plans ADD COLUMN source_id text;
    ALTER TABLE plans DROP CONSTRAINT recurring_payments_frequency_check;
    ALTER TABLE plans ADD CONSTRAINT plans_frequency_check CHECK (frequency IN ('once','monthly','weekly','yearly'));

    ALTER TABLE recurring_versions RENAME TO plan_versions;
    ALTER TABLE plan_versions RENAME COLUMN recurring_id TO plan_id;
    ALTER TABLE plan_versions DROP CONSTRAINT recurring_versions_frequency_check;
    ALTER TABLE plan_versions ADD CONSTRAINT plan_versions_frequency_check CHECK (frequency IN ('once','monthly','weekly','yearly'));

    ALTER TABLE payment_occurrences RENAME TO plan_occurrences;
    ALTER TABLE plan_occurrences RENAME COLUMN recurring_id TO plan_id;
    ALTER TABLE plan_occurrences ADD COLUMN moved_to text;
    ALTER TABLE plan_occurrences DROP CONSTRAINT payment_occurrences_status_check;
    ALTER TABLE plan_occurrences ADD CONSTRAINT plan_occurrences_status_check CHECK (status IN ('pending','paid','skipped','closed'));

    -- One-off calendar payments become one-off expense plans. Ones already marked done had no
    -- linked expense, so they are kept as "closed" dates instead of being invented as payments.
    INSERT INTO plans (id, title, category, amount, account_id, frequency, interval, start_date, end_date, note, active, direction, source)
      SELECT id, title, 'Другое', amount, NULL, 'once', 1, date, NULL, note, true, 'expense', 'manual'
      FROM events WHERE kind = 'payment' AND amount > 0;
    INSERT INTO plan_versions (id, plan_id, title, category, amount, account_id, frequency, interval, start_date, end_date, note, valid_from, valid_to)
      SELECT gen_random_uuid()::text, id, title, 'Другое', amount, NULL, 'once', 1, date, NULL, note, date, NULL
      FROM events WHERE kind = 'payment' AND amount > 0;
    INSERT INTO plan_occurrences (id, plan_id, due_date, title, category, amount, account_id, note, status, transaction_id)
      SELECT gen_random_uuid()::text, id, date, title, 'Другое', amount, NULL, note, 'closed', NULL
      FROM events WHERE kind = 'payment' AND amount > 0 AND done;
    DELETE FROM events WHERE kind = 'payment' AND amount > 0;
    UPDATE events SET kind = 'task', amount = NULL WHERE kind = 'payment';

    INSERT INTO lad_migrations (version) VALUES (6);
  END IF;
END $$;
`
