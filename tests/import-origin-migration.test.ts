import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { repairImportOrigin } from '../server/db/repair-import-origin'

// Immutable reproduction of the schema already applied in the affected app.
const earlyVersion3 = `
CREATE TABLE lad_migrations (version integer PRIMARY KEY);
INSERT INTO lad_migrations VALUES (1), (2), (3);
CREATE TABLE accounts (id text PRIMARY KEY, name text NOT NULL, opening_balance numeric(16,0) NOT NULL);
CREATE TABLE transactions (id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id),
  amount numeric(16,0) NOT NULL, import_key text, deleted_at timestamp);
CREATE UNIQUE INDEX transactions_import_key ON transactions(account_id, import_key);
INSERT INTO accounts VALUES ('a', 'Основной', 10000), ('b', 'Второй', 5000);
INSERT INTO transactions VALUES ('imported', 'a', 250, 'bank-1', NULL),
  ('deleted', 'a', 500, 'bank-2', '2026-11-05 10:00:00'), ('manual', 'b', 100, NULL, NULL);
`
const applyRepair = (db: PGlite) => db.exec(`BEGIN; ${repairImportOrigin} COMMIT;`)

describe('migration 4 repairs the deployed early version 3', () => {
  it('adds the missing column without changing accounts, amounts or deleted records', async () => {
    const db = new PGlite()
    try {
      await db.exec(earlyVersion3)
      const accounts = (await db.query('SELECT * FROM accounts ORDER BY id')).rows
      const history = (await db.query('SELECT * FROM transactions ORDER BY id')).rows
      await applyRepair(db)
      expect((await db.query('SELECT * FROM accounts ORDER BY id')).rows).toEqual(accounts)
      expect(
        (
          await db.query(
            'SELECT id, account_id, amount, import_key, deleted_at FROM transactions ORDER BY id',
          )
        ).rows,
      ).toEqual(history)
      expect(
        (await db.query('SELECT id, import_account_id FROM transactions ORDER BY id')).rows,
      ).toEqual([
        { id: 'deleted', import_account_id: 'a' },
        { id: 'imported', import_account_id: 'a' },
        { id: 'manual', import_account_id: null },
      ])
      await db.exec("UPDATE transactions SET account_id = 'b' WHERE id = 'imported'")
      await expect(
        db.exec("INSERT INTO transactions VALUES ('duplicate', 'a', 250, 'bank-1', NULL, 'a')"),
      ).rejects.toThrow()
      await applyRepair(db)
      expect(
        (await db.query("SELECT import_account_id FROM transactions WHERE id = 'imported'"))
          .rows[0],
      ).toEqual({ import_account_id: 'a' })
      expect((await db.query('SELECT version FROM lad_migrations ORDER BY version')).rows).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
      ])
    } finally {
      await db.close()
    }
  })
  it('accepts an existing column and preserves an already recorded original account', async () => {
    const db = new PGlite()
    try {
      await db.exec(earlyVersion3)
      await db.exec(
        "ALTER TABLE transactions ADD COLUMN import_account_id text REFERENCES accounts(id); UPDATE transactions SET import_account_id = 'a', account_id = 'b' WHERE id = 'imported';",
      )
      await applyRepair(db)
      expect(
        (
          await db.query(
            "SELECT account_id, import_account_id FROM transactions WHERE id = 'imported'",
          )
        ).rows[0],
      ).toEqual({ account_id: 'b', import_account_id: 'a' })
      expect(
        (await db.query('SELECT count(*)::int AS count FROM transactions')).rows[0]!.count,
      ).toBe(3)
    } finally {
      await db.close()
    }
  })
})
