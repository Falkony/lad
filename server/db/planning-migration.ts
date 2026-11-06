// Complete, immutable iteration-3 migration. Register only after testing it.
export const planningMigration = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 5) THEN
    CREATE TABLE budgets (id text PRIMARY KEY, month text NOT NULL, category text NOT NULL, "limit" numeric(16,0) NOT NULL CHECK ("limit" >= 0), UNIQUE(month, category));
    CREATE TABLE recurring_payments (id text PRIMARY KEY, title text NOT NULL, category text NOT NULL, amount numeric(16,0) NOT NULL CHECK (amount > 0), account_id text REFERENCES accounts(id), frequency text NOT NULL CHECK (frequency IN ('monthly','weekly','yearly')), interval integer NOT NULL CHECK (interval BETWEEN 1 AND 12), start_date text NOT NULL, end_date text, note text NOT NULL, active boolean NOT NULL DEFAULT true, CHECK(end_date IS NULL OR end_date >= start_date));
    CREATE TABLE recurring_versions (id text PRIMARY KEY, recurring_id text NOT NULL REFERENCES recurring_payments(id), title text NOT NULL, category text NOT NULL, amount numeric(16,0) NOT NULL CHECK(amount > 0), account_id text REFERENCES accounts(id), frequency text NOT NULL CHECK(frequency IN ('monthly','weekly','yearly')), interval integer NOT NULL CHECK(interval BETWEEN 1 AND 12), start_date text NOT NULL, end_date text, note text NOT NULL, valid_from text NOT NULL, valid_to text, CHECK(valid_to IS NULL OR valid_to >= valid_from), CHECK(end_date IS NULL OR end_date >= start_date));
    CREATE INDEX recurring_versions_rule ON recurring_versions(recurring_id);
    CREATE UNIQUE INDEX recurring_versions_open ON recurring_versions(recurring_id) WHERE valid_to IS NULL;
    CREATE TABLE payment_occurrences (id text PRIMARY KEY, recurring_id text NOT NULL REFERENCES recurring_payments(id), due_date text NOT NULL, title text NOT NULL, category text NOT NULL, amount numeric(16,0) NOT NULL CHECK(amount > 0), account_id text REFERENCES accounts(id), note text NOT NULL, status text NOT NULL CHECK(status IN ('pending','paid','skipped')), transaction_id text UNIQUE REFERENCES transactions(id), UNIQUE(recurring_id, due_date), CHECK((status = 'paid') = (transaction_id IS NOT NULL)));
    INSERT INTO lad_migrations(version) VALUES(5);
  END IF;
END $$;
`
