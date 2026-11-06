import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'
import { isNonWorkingDay, previousWorkingDay } from '../shared/workdays'
import { frequencyLabel, projectPlans, recurringDates } from '../shared/planning'
import { planSchema } from '../shared/planning-schemas'
import type { PlanVersion } from '../shared/planning-types'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import { migration, migrationThrough } from '../server/db/migration'
import { payDaysMigration } from '../server/db/pay-days-migration'
import { obligationMigration } from '../server/db/obligation-migration'
import { backupSchema, createBackup } from '../shared/backup'
import * as money from '../shared/money'

describe('production calendar', () => {
  it('knows weekends, holidays and the 2026 decree', () => {
    expect(isNonWorkingDay('2026-11-07')).toBe(true) // Saturday
    expect(isNonWorkingDay('2026-11-04')).toBe(true) // National Unity Day
    expect(isNonWorkingDay('2026-11-05')).toBe(false)
    expect(isNonWorkingDay('2026-01-09')).toBe(true) // moved from 3 January
    expect(isNonWorkingDay('2026-12-31')).toBe(true) // moved from 4 January
    expect(isNonWorkingDay('2026-01-12')).toBe(false)
  })
  it('follows the 2025 decree, which moved weekend holidays elsewhere', () => {
    expect(isNonWorkingDay('2025-02-24')).toBe(false) // 23 February moved to 8 May
    expect(isNonWorkingDay('2025-05-08')).toBe(true)
    expect(isNonWorkingDay('2025-06-13')).toBe(true)
    expect(isNonWorkingDay('2025-11-01')).toBe(false) // working Saturday
    expect(isNonWorkingDay('2025-12-31')).toBe(true)
  })
  it('moves a holiday on a weekend to the next working day, except in January', () => {
    expect(isNonWorkingDay('2026-03-09')).toBe(true) // 8 March is a Sunday
    expect(isNonWorkingDay('2026-05-11')).toBe(true) // 9 May is a Saturday
    // 2027 has no decree yet: the general rule still applies.
    expect(isNonWorkingDay('2027-06-14')).toBe(true) // 12 June 2027 is a Saturday
    expect(isNonWorkingDay('2027-01-11')).toBe(false)
  })
  it('finds the working day before a day off', () => {
    expect(previousWorkingDay('2026-12-05')).toBe('2026-12-04') // Saturday → Friday
    expect(previousWorkingDay('2026-11-04')).toBe('2026-11-03') // holiday → eve
    expect(previousWorkingDay('2026-01-10')).toBe('2025-12-30') // New Year holidays
    expect(previousWorkingDay('2026-11-05')).toBe('2026-11-05')
  })
})

const version = (data: Partial<PlanVersion>): PlanVersion => ({
  id: 'v',
  planId: 'salary',
  title: 'Зарплата',
  category: 'Зарплата',
  amount: '100',
  accountId: null,
  frequency: 'monthly',
  interval: 1,
  startDate: '2026-11-01',
  endDate: null,
  note: '',
  monthDays: [],
  holidayShift: 'none',
  validFrom: '2026-01-01',
  validTo: null,
  ...data,
})
const plan = {
  id: 'salary',
  title: 'Зарплата',
  category: 'Зарплата',
  amount: '100',
  accountId: null,
  frequency: 'monthly' as const,
  interval: 1,
  startDate: '2026-11-01',
  endDate: null,
  note: '',
  monthDays: [5, 20],
  holidayShift: 'before' as const,
  active: true,
  direction: 'income' as const,
  source: 'manual' as const,
  sourceId: null,
}
const workspace = (v: PlanVersion) => ({
  plans: [plan],
  planVersions: [v],
  planOccurrences: [],
  transactions: [],
  deletedTransactions: [],
})

describe('several pay days a month', () => {
  it('repeats each day every month and clamps short months', () => {
    const v = version({ monthDays: [5, 20] })
    expect(recurringDates(v, '2026-11-01', '2027-01-31')).toEqual([
      '2026-11-05',
      '2026-11-20',
      '2026-12-05',
      '2026-12-20',
      '2027-01-05',
      '2027-01-20',
    ])
    const ends = version({ monthDays: [15, 30, 31], startDate: '2027-02-01' })
    expect(recurringDates(ends, '2027-02-01', '2027-02-28')).toEqual(['2027-02-15', '2027-02-28'])
    // Days before the first date are not scheduled.
    expect(
      recurringDates(
        version({ monthDays: [5, 20], startDate: '2026-11-10' }),
        '2026-11-01',
        '2026-11-30',
      ),
    ).toEqual(['2026-11-20'])
  })
  it('validates and sorts the days', () => {
    const base = {
      title: 'З',
      category: 'З',
      amount: '1',
      frequency: 'monthly',
      startDate: '2026-11-01',
    }
    expect(planSchema.parse({ ...base, monthDays: [20, 5] }).monthDays).toEqual([5, 20])
    expect(planSchema.safeParse({ ...base, monthDays: [5, 5] }).success).toBe(false)
    expect(planSchema.safeParse({ ...base, monthDays: [32] }).success).toBe(false)
    expect(planSchema.safeParse({ ...base, frequency: 'weekly', monthDays: [5] }).success).toBe(
      false,
    )
    expect(frequencyLabel('monthly', 1, [5, 20])).toBe('Каждый месяц, 5 и 20 числа')
    expect(frequencyLabel('monthly', 1, [1, 10, 20])).toBe('Каждый месяц, 1, 10 и 20 числа')
  })
  it('pays on the eve of a day off on a five-day week', () => {
    const v = version({ monthDays: [5, 20], holidayShift: 'before' })
    const dates = projectPlans(workspace(v), '2026-12-01', '2027-01-31').map((p) => [
      p.dueDate,
      p.date,
    ])
    expect(dates).toEqual([
      ['2026-12-05', '2026-12-04'], // Saturday
      ['2026-12-20', '2026-12-18'], // Sunday
      ['2027-01-05', '2026-12-30'], // New Year holidays: 31 December is a day off in 2026
      ['2027-01-20', '2027-01-20'],
    ])
    // A shifted date shows up in the range of its effective date.
    expect(projectPlans(workspace(v), '2026-12-01', '2026-12-04').map((p) => p.dueDate)).toEqual([
      '2026-12-05',
    ])
    expect(projectPlans(workspace(v), '2026-12-05', '2026-12-10')).toEqual([])
    // Shift workers get paid on the date itself.
    const shift = version({ monthDays: [5, 20] })
    expect(projectPlans(workspace(shift), '2026-12-01', '2026-12-10').map((p) => p.date)).toEqual([
      '2026-12-05',
    ])
  })
})

const run = async (input: unknown) => executeCommand(commandSchema.parse(input))
const revision = async () => (await readWorkspace()).revision
describe('pay days on the server', () => {
  let accountId: string
  beforeAll(async () => {
    process.env.LAD_DATA_DIR = join(await mkdtemp(join(tmpdir(), 'lad-paydays-')), 'db')
    delete process.env.DATABASE_URL
  })
  beforeEach(async () => {
    vi.spyOn(money, 'localDate').mockReturnValue('2026-11-06')
    await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
    await run({ op: 'account.create', data: { name: 'Карта', openingBalance: '0' } })
    accountId = (await readWorkspace()).accounts[0]!.id
  })
  afterEach(() => vi.restoreAllMocks())
  const save = (data: Record<string, unknown> = {}) =>
    run({
      op: 'plan.save',
      direction: 'income',
      data: {
        title: 'Аванс и зарплата',
        category: 'Зарплата',
        amount: '5000000',
        accountId,
        frequency: 'monthly',
        startDate: '2026-11-01',
        monthDays: [20, 5],
        holidayShift: 'before',
        ...data,
      },
    })

  it('stores the days and the shift in the plan and its schedule', async () => {
    await save()
    const state = await readWorkspace()
    expect(state.plans[0]).toMatchObject({ monthDays: [5, 20], holidayShift: 'before' })
    expect(state.planVersions[0]).toMatchObject({ monthDays: [5, 20], holidayShift: 'before' })
    expect(projectPlans(state, '2026-12-01', '2026-12-31').map((p) => p.date)).toEqual([
      '2026-12-04',
      '2026-12-18',
      '2026-12-30', // 5 January 2027 falls in the New Year holidays
    ])
  })

  it('confirms a shifted date and keeps a manual move onto a day off', async () => {
    await save()
    const id = (await readWorkspace()).plans[0]!.id
    // Moving back to the scheduled (shifted) date is not a move.
    await run({
      op: 'occurrence.adjust',
      planId: id,
      dueDate: '2026-12-05',
      date: '2026-12-04',
      amount: '4000000',
      expectedRevision: await revision(),
    })
    let state = await readWorkspace()
    expect(state.planOccurrences[0]).toMatchObject({ movedTo: null, amount: '4000000' })
    // A date the user picks stays where it is, even on a Saturday.
    await run({
      op: 'occurrence.adjust',
      planId: id,
      dueDate: '2026-12-20',
      date: '2026-12-19',
      amount: '5000000',
      expectedRevision: await revision(),
    })
    state = await readWorkspace()
    expect(projectPlans(state, '2026-12-01', '2026-12-31').map((p) => p.date)).toEqual([
      '2026-12-04',
      '2026-12-19',
      '2026-12-30',
    ])
    // An overdue shifted date is confirmed by its original key.
    vi.spyOn(money, 'localDate').mockReturnValue('2026-11-20')
    await run({
      op: 'occurrence.confirm',
      planId: id,
      dueDate: '2026-11-05',
      mode: 'create',
      accountId,
      amount: '5000000',
      date: '2026-11-05',
      expectedRevision: await revision(),
    })
    state = await readWorkspace()
    expect(
      projectPlans(state, '2026-11-01', '2026-11-30').map((p) => [p.dueDate, p.status]),
    ).toEqual([
      ['2026-11-05', 'paid'],
      ['2026-11-20', 'pending'],
    ])
  })

  it('restores copies made before pay days with one day and no shift', async () => {
    await save()
    const backup = JSON.parse(JSON.stringify(createBackup(await readWorkspace())))
    for (const row of [...backup.plans, ...backup.planVersions]) {
      delete row.monthDays
      delete row.holidayShift
    }
    expect(backupSchema.parse(backup).plans[0]).toMatchObject({
      monthDays: [],
      holidayShift: 'none',
    })
    await run({
      op: 'workspace.restore',
      backup,
      expectedRevision: await revision(),
      confirmation: 'ВОССТАНОВИТЬ',
    })
    expect((await readWorkspace()).plans[0]).toMatchObject({ monthDays: [], holidayShift: 'none' })
  })

  it('migration 8 keeps existing plans on their single day', async () => {
    const db = new PGlite()
    try {
      await db.exec(migrationThrough(7))
      await db.exec(`
        INSERT INTO plans (id,title,category,amount,account_id,frequency,interval,start_date,note,direction)
          VALUES ('p','Зарплата','Зарплата',100,NULL,'monthly',1,'2026-01-10','','income');
      `)
      await db.exec(migration)
      await db.exec(migration)
      expect((await db.query('SELECT month_days, holiday_shift FROM plans')).rows).toEqual([
        { month_days: [], holiday_shift: 'none' },
      ])
    } finally {
      await db.close()
    }
  })
})
