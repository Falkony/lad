import { it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migration } from '../server/db/migration'
it('upgrades an existing obligation table without losing its records', async () => {
  const db = new PGlite()
  try {
    await db.exec(
      "CREATE TABLE obligations (id text PRIMARY KEY, title text NOT NULL, kind text NOT NULL, remaining numeric(16,0) NOT NULL CHECK (remaining > 0), payment numeric(16,0) NOT NULL, due_day integer NOT NULL, rate text NOT NULL); INSERT INTO obligations VALUES ('old','Старый долг','debt',10000,1000,10,'0');",
    )
    await db.exec(migration)
    await db.exec("UPDATE obligations SET remaining = 0 WHERE id = 'old'")
    await db.exec(migration)
    expect(
      (await db.query<{ remaining: string }>("SELECT remaining FROM obligations WHERE id = 'old'"))
        .rows[0]!.remaining,
    ).toBe('0')
    expect((await db.query('SELECT version FROM lad_migrations')).rows).toHaveLength(6)
  } finally {
    await db.close()
  }
})
it('preserves legacy accounts and import history while adding iteration 2 fields', async () => {
  const db = new PGlite()
  try {
    await db.exec(
      migration.slice(0, migration.indexOf('CREATE TABLE IF NOT EXISTS workspace_guard')) +
        'COMMIT;',
    )
    await db.exec(
      "INSERT INTO accounts VALUES ('legacy','Счёт','card',10000,'green'); INSERT INTO transactions (id,kind,amount,account_id,category,description,date,import_key) VALUES ('row','expense',100,'legacy','Дом','','2026-01-01','bank-id');",
    )
    await db.exec(migration)
    await db.exec(migration)
    expect(
      (await db.query('SELECT name, opening_balance, archived, bank_name, last4 FROM accounts'))
        .rows[0],
    ).toEqual({ name: 'Счёт', opening_balance: '10000', archived: false, bank_name: '', last4: '' })
    expect(
      (await db.query('SELECT import_account_id, deleted_at FROM transactions')).rows[0],
    ).toEqual({ import_account_id: 'legacy', deleted_at: null })
    await db.exec(
      "INSERT INTO transactions (id,kind,amount,account_id,category,description,date) VALUES ('adjust','adjustment',-50,'legacy','Корректировка','','2026-01-02');",
    )
    expect((await db.query('SELECT count(*)::int AS count FROM transactions')).rows[0]!.count).toBe(
      2,
    )
  } finally {
    await db.close()
  }
})
