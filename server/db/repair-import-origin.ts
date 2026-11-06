// Migration 3 was observed by a running dev server before the import-origin
// field was added. Repair that deployed schema with a new, independent version.
export const repairImportOrigin = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 4) THEN
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_account_id text REFERENCES accounts(id);
    UPDATE transactions SET import_account_id = account_id
      WHERE import_key IS NOT NULL AND import_account_id IS NULL;
    DROP INDEX IF EXISTS transactions_import_key;
    CREATE UNIQUE INDEX transactions_import_key ON transactions(COALESCE(import_account_id, account_id), import_key);
    INSERT INTO lad_migrations (version) VALUES (4);
  END IF;
END $$;
`
