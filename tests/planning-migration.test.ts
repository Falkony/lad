import { it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migration } from '../server/db/migration'
import { planningMigration } from '../server/db/planning-migration'
import { unifiedPlanMigration } from '../server/db/unified-plan-migration'
it('adds planning tables to version 4 without rewriting the ledger and is repeatable', async () => {
  const db = new PGlite()
  try {
    await db.exec(migration.replace(planningMigration, '').replace(unifiedPlanMigration, ''))
    await db.exec(
      "INSERT INTO accounts (id,name,kind,opening_balance,color) VALUES ('a','Счёт','card',10000,'green'); INSERT INTO transactions(id,kind,amount,account_id,category,description,date) VALUES ('t','expense',1250,'a','Дом','Пример','2026-01-01');",
    )
    const before = (await db.query('SELECT * FROM transactions')).rows
    await db.exec(`BEGIN; ${planningMigration} COMMIT;`)
    await db.exec(`BEGIN; ${planningMigration} COMMIT;`)
    expect((await db.query('SELECT * FROM transactions')).rows).toEqual(before)
    for (const table of [
      'budgets',
      'recurring_payments',
      'recurring_versions',
      'payment_occurrences',
    ])
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([])
    expect(
      (await db.query('SELECT version FROM lad_migrations WHERE version = 5')).rows,
    ).toHaveLength(1)
  } finally {
    await db.close()
  }
})
