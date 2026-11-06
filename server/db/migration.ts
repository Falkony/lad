import { repairImportOrigin } from './repair-import-origin'
import { planningMigration } from './planning-migration'
import { unifiedPlanMigration } from './unified-plan-migration'
import { forecastMigration } from './forecast-migration'
import { payDaysMigration } from './pay-days-migration'
import { obligationMigration } from './obligation-migration'
import { commandHistoryMigration } from './command-history-migration'
import { foundationMigration } from './foundation-migration'
import { creditMigration } from './credit-migration'

export const migrationSteps = [
  { version: 4, sql: repairImportOrigin },
  { version: 5, sql: planningMigration },
  { version: 6, sql: unifiedPlanMigration },
  { version: 7, sql: forecastMigration },
  { version: 8, sql: payDaysMigration },
  { version: 9, sql: obligationMigration },
  { version: 10, sql: commandHistoryMigration },
  { version: 11, sql: foundationMigration },
  { version: 12, sql: creditMigration },
]
export const latestMigrationVersion = migrationSteps.at(-1)!.version

// Bootstrap for new databases followed by guarded, versioned upgrades for existing ones.
export const migration = `
BEGIN;
CREATE TABLE IF NOT EXISTS lad_migrations (version integer PRIMARY KEY, applied_at timestamp NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS accounts (id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL, opening_balance numeric(16,0) NOT NULL, color text NOT NULL);
CREATE TABLE IF NOT EXISTS transactions (id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('expense','income','transfer')), amount numeric(16,0) NOT NULL CHECK (amount > 0), account_id text NOT NULL REFERENCES accounts(id), to_account_id text REFERENCES accounts(id), category text NOT NULL, description text NOT NULL, date text NOT NULL, import_key text, created_at timestamp NOT NULL DEFAULT now(), CHECK (kind <> 'transfer' OR (to_account_id IS NOT NULL AND to_account_id <> account_id)));
CREATE UNIQUE INDEX IF NOT EXISTS transactions_import_key ON transactions(account_id, import_key);
CREATE INDEX IF NOT EXISTS transactions_date ON transactions(date);
CREATE TABLE IF NOT EXISTS goals (id text PRIMARY KEY, title text NOT NULL, target numeric(16,0) NOT NULL CHECK (target > 0), saved numeric(16,0) NOT NULL CHECK (saved >= 0), status text NOT NULL, priority text NOT NULL, deadline text);
CREATE TABLE IF NOT EXISTS events (id text PRIMARY KEY, title text NOT NULL, date text NOT NULL, kind text NOT NULL, amount numeric(16,0), done boolean NOT NULL DEFAULT false, note text NOT NULL);
CREATE TABLE IF NOT EXISTS shopping (id text PRIMARY KEY, title text NOT NULL, quantity text NOT NULL, price numeric(16,0) NOT NULL CHECK (price >= 0), checked boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS obligations (id text PRIMARY KEY, title text NOT NULL, kind text NOT NULL, remaining numeric(16,0) NOT NULL CHECK (remaining >= 0), payment numeric(16,0) NOT NULL CHECK (payment >= 0), due_day integer NOT NULL CHECK (due_day BETWEEN 1 AND 31), rate text NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO lad_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 2) THEN
    ALTER TABLE obligations DROP CONSTRAINT IF EXISTS obligations_remaining_check;
    ALTER TABLE obligations ADD CONSTRAINT obligations_remaining_check CHECK (remaining >= 0);
    INSERT INTO lad_migrations (version) VALUES (2);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS workspace_guard (id integer PRIMARY KEY CHECK (id = 1), revision numeric(20,0) NOT NULL DEFAULT 0);
INSERT INTO workspace_guard (id) VALUES (1) ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 3) THEN
    ALTER TABLE accounts ADD COLUMN bank_name text NOT NULL DEFAULT '';
    ALTER TABLE accounts ADD COLUMN last4 text NOT NULL DEFAULT '';
    ALTER TABLE accounts ADD COLUMN archived boolean NOT NULL DEFAULT false;
    ALTER TABLE transactions ADD COLUMN deleted_at timestamp;
    ALTER TABLE transactions ADD COLUMN import_account_id text REFERENCES accounts(id);
    UPDATE transactions SET import_account_id = account_id WHERE import_key IS NOT NULL;
    DROP INDEX transactions_import_key;
    CREATE UNIQUE INDEX transactions_import_key ON transactions(COALESCE(import_account_id, account_id), import_key);
    ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
    ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_amount_check;
    ALTER TABLE transactions ADD CONSTRAINT transactions_kind_check CHECK (kind IN ('expense','income','transfer','adjustment'));
    ALTER TABLE transactions ADD CONSTRAINT transactions_amount_check CHECK ((kind = 'adjustment' AND amount <> 0) OR (kind <> 'adjustment' AND amount > 0));
    INSERT INTO lad_migrations (version) VALUES (3);
  END IF;
END $$;
${migrationSteps.map((step) => step.sql).join('\n')}
COMMIT;
`

export function migrationThrough(version: number) {
  return migrationSteps
    .filter((step) => step.version > version)
    .reduce((source, step) => source.replace(step.sql, ''), migration)
}
