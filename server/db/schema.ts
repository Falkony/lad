import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
} from 'drizzle-orm/pg-core'
import type { CommandHistoryEntry } from '../../shared/command-history'

// Money is an integer minor-unit string at the API boundary. PostgreSQL numeric(16,0)
// preserves it exactly without a lossy conversion to JavaScript number.
import { numeric } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
const money = (name: string) => numeric(name, { precision: 16, scale: 0 }).notNull()
export const categories = pgTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  archived: boolean('archived').notNull().default(false),
})
const categoryReference = () =>
  text('category_id')
    .references(() => categories.id)
    .default(sql`NULL`)
    .notNull()
export const accounts = pgTable('accounts', {
  creditSettings: jsonb('credit_settings')
    .$type<import('../../shared/credit').CreditSettings>()
    .notNull()
    .default({
      limit: '0',
      minimumPayment: '0',
      paymentDay: 20,
      graceUntil: null,
      payerAccountId: null,
      payFull: true,
    }),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  openingBalance: money('opening_balance'),
  color: text('color').notNull(),
  bankName: text('bank_name').notNull().default(''),
  last4: text('last4').notNull().default(''),
  archived: boolean('archived').notNull().default(false),
  inForecast: boolean('in_forecast').notNull().default(true),
})
export const transactions = pgTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    amount: money('amount'),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    toAccountId: text('to_account_id').references(() => accounts.id),
    category: text('category').notNull(),
    categoryId: categoryReference(),
    description: text('description').notNull(),
    date: text('date').notNull(),
    importKey: text('import_key'),
    importAccountId: text('import_account_id').references(() => accounts.id),
    createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { mode: 'string' }),
  },
  (t) => [
    uniqueIndex('transactions_import_key').on(
      sql`coalesce(${t.importAccountId}, ${t.accountId})`,
      t.importKey,
    ),
    index('transactions_date').on(t.date),
  ],
)
export const goals = pgTable('goals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  target: money('target'),
  saved: money('saved'),
  status: text('status').notNull(),
  priority: text('priority').notNull(),
  deadline: text('deadline'),
})
export const events = pgTable('events', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  date: text('date').notNull(),
  kind: text('kind').notNull(),
  amount: numeric('amount', { precision: 16, scale: 0 }),
  done: boolean('done').notNull().default(false),
  note: text('note').notNull(),
})
export const shopping = pgTable('shopping', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  quantity: text('quantity').notNull(),
  price: money('price'),
  checked: boolean('checked').notNull().default(false),
})
export const obligations = pgTable('obligations', {
  bankSchedule: jsonb('bank_schedule')
    .$type<NonNullable<import('../../shared/types').Obligation['bankSchedule']>>()
    .notNull()
    .default([]),
  interestMethod: text('interest_method').notNull().default('monthly'),
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  kind: text('kind').notNull(),
  // The balance on the start date of accounting; the current one follows from the entries.
  openingBalance: money('opening_balance'),
  startDate: text('start_date').notNull(),
  accountId: text('account_id').references(() => accounts.id),
  payment: money('payment'),
  dueDay: integer('due_day').notNull(),
  rate: text('rate').notNull(),
})
// Repayments (linked to a transaction) and reconciliations with the bank (migration 9).
export const obligationEntries = pgTable(
  'obligation_entries',
  {
    id: text('id').primaryKey(),
    obligationId: text('obligation_id')
      .notNull()
      .references(() => obligations.id),
    kind: text('kind').notNull(),
    date: text('date').notNull(),
    principal: numeric('principal', { precision: 16, scale: 0 }).notNull(),
    interest: numeric('interest', { precision: 16, scale: 0 }).notNull().default('0'),
    fees: numeric('fees', { precision: 16, scale: 0 }).notNull().default('0'),
    transactionId: text('transaction_id')
      .unique()
      .references(() => transactions.id),
    early: text('early').notNull().default('none'),
    previousPayment: numeric('previous_payment', { precision: 16, scale: 0 }),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('obligation_entries_obligation').on(t.obligationId)],
)
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
export const workspaceGuard = pgTable('workspace_guard', {
  id: integer('id').primaryKey(),
  revision: numeric('revision', { precision: 20, scale: 0 }).notNull().default('0'),
})
export const commandHistory = pgTable('command_history', {
  id: text('id').primaryKey(),
  revision: numeric('revision', { precision: 20, scale: 0 }).notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
  operation: text('operation').notNull(),
  payload: jsonb('payload').$type<CommandHistoryEntry['payload']>().notNull(),
  result: jsonb('result').$type<CommandHistoryEntry['result']>().notNull(),
})
export const budgets = pgTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    month: text('month').notNull(),
    category: text('category').notNull(),
    categoryId: categoryReference(),
    limit: money('limit'),
  },
  (t) => [uniqueIndex('budgets_month_category').on(t.month, t.category)],
)
const planFields = () => ({
  customDates: jsonb('custom_dates')
    .$type<{ date: string; amount: string }[]>()
    .notNull()
    .default([]),
  title: text('title').notNull(),
  category: text('category').notNull(),
  categoryId: categoryReference(),
  amount: money('amount'),
  accountId: text('account_id').references(() => accounts.id),
  frequency: text('frequency').notNull(),
  interval: integer('interval').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date'),
  note: text('note').notNull(),
  monthDays: integer('month_days').array().notNull().default([]),
  holidayShift: text('holiday_shift').notNull().default('none'),
})
// One model for every planned income and payment: one-off or recurring (migration 6).
export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  ...planFields(),
  active: boolean('active').notNull().default(true),
  direction: text('direction').notNull().default('expense'),
  source: text('source').notNull().default('manual'),
  sourceId: text('source_id'),
})
// Index names keep their pre-migration-6 names: renaming a table does not rename its indexes.
export const planVersions = pgTable(
  'plan_versions',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id),
    ...planFields(),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
  },
  (t) => [
    index('recurring_versions_rule').on(t.planId),
    uniqueIndex('recurring_versions_open')
      .on(t.planId)
      .where(sql`${t.validTo} is null`),
  ],
)
export const planOccurrences = pgTable(
  'plan_occurrences',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id),
    dueDate: text('due_date').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    categoryId: categoryReference(),
    amount: money('amount'),
    accountId: text('account_id').references(() => accounts.id),
    note: text('note').notNull(),
    status: text('status').notNull(),
    transactionId: text('transaction_id')
      .unique()
      .references(() => transactions.id),
    movedTo: text('moved_to'),
  },
  (t) => [uniqueIndex('payment_occurrences_recurring_id_due_date_key').on(t.planId, t.dueDate)],
)
