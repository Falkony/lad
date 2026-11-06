import { pgTable, text, boolean, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

// Money is an integer minor-unit string at the API boundary. PostgreSQL numeric(16,0)
// preserves it exactly without a lossy conversion to JavaScript number.
import { numeric } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
const money = (name: string) => numeric(name, { precision: 16, scale: 0 }).notNull()
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  openingBalance: money('opening_balance'),
  color: text('color').notNull(),
  bankName: text('bank_name').notNull().default(''),
  last4: text('last4').notNull().default(''),
  archived: boolean('archived').notNull().default(false),
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
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  kind: text('kind').notNull(),
  remaining: money('remaining'),
  payment: money('payment'),
  dueDay: integer('due_day').notNull(),
  rate: text('rate').notNull(),
})
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
export const workspaceGuard = pgTable('workspace_guard', {
  id: integer('id').primaryKey(),
  revision: numeric('revision', { precision: 20, scale: 0 }).notNull().default('0'),
})
export const budgets = pgTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    month: text('month').notNull(),
    category: text('category').notNull(),
    limit: money('limit'),
  },
  (t) => [uniqueIndex('budgets_month_category').on(t.month, t.category)],
)
const recurringFields = () => ({
  title: text('title').notNull(),
  category: text('category').notNull(),
  amount: money('amount'),
  accountId: text('account_id').references(() => accounts.id),
  frequency: text('frequency').notNull(),
  interval: integer('interval').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date'),
  note: text('note').notNull(),
})
export const recurringPayments = pgTable('recurring_payments', {
  id: text('id').primaryKey(),
  ...recurringFields(),
  active: boolean('active').notNull().default(true),
})
export const recurringVersions = pgTable(
  'recurring_versions',
  {
    id: text('id').primaryKey(),
    recurringId: text('recurring_id')
      .notNull()
      .references(() => recurringPayments.id),
    ...recurringFields(),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
  },
  (t) => [
    index('recurring_versions_rule').on(t.recurringId),
    uniqueIndex('recurring_versions_open')
      .on(t.recurringId)
      .where(sql`${t.validTo} is null`),
  ],
)
export const paymentOccurrences = pgTable(
  'payment_occurrences',
  {
    id: text('id').primaryKey(),
    recurringId: text('recurring_id')
      .notNull()
      .references(() => recurringPayments.id),
    dueDate: text('due_date').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    amount: money('amount'),
    accountId: text('account_id').references(() => accounts.id),
    note: text('note').notNull(),
    status: text('status').notNull(),
    transactionId: text('transaction_id')
      .unique()
      .references(() => transactions.id),
  },
  (t) => [uniqueIndex('payment_occurrences_rule_date').on(t.recurringId, t.dueDate)],
)
