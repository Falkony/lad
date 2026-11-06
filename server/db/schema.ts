import {
  type AnyPgColumn,
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
export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
})
export const authWorkspaces = pgTable('auth_workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').references(() => authUsers.id),
  singleton: boolean('singleton').notNull().default(true).unique(),
})
export const authMemberships = pgTable(
  'auth_memberships',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => authWorkspaces.id),
    role: text('role').notNull(),
  },
  (t) => [uniqueIndex('auth_memberships_user_id_workspace_id_key').on(t.userId, t.workspaceId)],
)
export const authSessions = pgTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => authUsers.id),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => authWorkspaces.id),
  tokenHash: text('token_hash').notNull().unique(),
  deviceName: text('device_name').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
})
export const authLoginAttempts = pgTable('auth_login_attempts', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  startedAt: text('started_at').notNull(),
})
const workspaceReference = () =>
  text('workspace_id')
    .notNull()
    .default(sql`lad_workspace_id()`)
    .references(() => authWorkspaces.id)
export const categories = pgTable('categories', {
  workspaceId: workspaceReference(),
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  archived: boolean('archived').notNull().default(false),
})
const categoryReference = () =>
  text('category_id')
    .references(() => categories.id)
    .default(sql`NULL`)
    .notNull()
export const importRules = pgTable('import_rules', {
  workspaceId: workspaceReference(),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  pattern: text('pattern').notNull(),
  accountId: text('account_id').references(() => accounts.id),
  kind: text('kind'),
  categoryId: text('category_id')
    .notNull()
    .references(() => categories.id),
  priority: integer('priority').notNull().default(100),
  enabled: boolean('enabled').notNull().default(true),
})
export const importTemplates = pgTable('import_templates', {
  workspaceId: workspaceReference(),
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  mapping: jsonb('mapping')
    .$type<import('../../shared/import-workflow').ImportTemplate['mapping']>()
    .notNull(),
})
export const importBatches = pgTable('import_batches', {
  workspaceId: workspaceReference(),
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  fileName: text('file_name').notNull(),
  status: text('status').notNull(),
  revision: text('revision').notNull(),
  report: jsonb('report')
    .$type<import('../../shared/import-workflow').ImportBatch['report']>()
    .notNull(),
  records: jsonb('records')
    .$type<import('../../shared/import-workflow').ImportBatch['records']>()
    .notNull(),
})
export const importKeys = pgTable(
  'import_keys',
  {
    workspaceId: workspaceReference(),
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    key: text('key').notNull(),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id),
    batchId: text('batch_id').references(() => importBatches.id),
  },
  (t) => [uniqueIndex('import_keys_account_id_key_key').on(t.accountId, t.key)],
)
export const accounts = pgTable('accounts', {
  workspaceId: workspaceReference(),
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
export const budgetHistory = pgTable(
  'budget_history',
  {
    workspaceId: workspaceReference(),
    id: text('id').primaryKey(),
    month: text('month').notNull(),
    categoryId: text('category_id').notNull(),
    category: text('category').notNull(),
    oldLimit: numeric('old_limit', { precision: 16, scale: 0 }),
    newLimit: numeric('new_limit', { precision: 16, scale: 0 }),
    revision: numeric('revision', { precision: 20, scale: 0 }).notNull(),
    createdAt: text('created_at').notNull(),
    operation: text('operation').notNull(),
  },
  (t) => [
    uniqueIndex('budget_history_revision_month_category_id_key').on(
      t.revision,
      t.month,
      t.categoryId,
    ),
  ],
)
export const reconciliations = pgTable(
  'reconciliations',
  {
    workspaceId: workspaceReference(),
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    date: text('date').notNull(),
    balance: money('balance'),
    revision: numeric('revision', { precision: 20, scale: 0 }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('reconciliations_account_date').on(t.accountId, t.date)],
)
export const periodClosures = pgTable(
  'period_closures',
  {
    workspaceId: workspaceReference(),
    id: text('id').primaryKey(),
    month: text('month').notNull(),
    generation: integer('generation').notNull(),
    status: text('status').notNull(),
    sourceRevision: text('source_revision').notNull(),
    revision: text('revision').notNull(),
    createdAt: text('created_at').notNull(),
    reopenedAt: text('reopened_at'),
    note: text('note').notNull(),
    reopenNote: text('reopen_note').notNull(),
    snapshot: jsonb('snapshot').$type<import('../../shared/periods').MonthReport>().notNull(),
    sha256: text('sha256').notNull(),
  },
  (t) => [uniqueIndex('period_closures_month_generation_key').on(t.month, t.generation)],
)
export const transactions = pgTable(
  'transactions',
  {
    workspaceId: workspaceReference(),
    splits: jsonb('splits')
      .$type<import('../../shared/transaction-details').TransactionSplit[]>()
      .notNull()
      .default([]),
    refundOf: text('refund_of').references((): AnyPgColumn => transactions.id),
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
    index('transactions_page').on(t.date.desc(), t.createdAt.desc(), t.id.desc()),
    index('transactions_account_date').on(t.accountId, t.date),
    index('transactions_target_date').on(t.toAccountId, t.date),
    index('transactions_refund').on(t.refundOf),
  ],
)
export const goals = pgTable('goals', {
  workspaceId: workspaceReference(),
  mandatory: boolean('mandatory').notNull().default(false),
  categoryId: text('category_id').references(() => categories.id),
  purchaseMonth: text('purchase_month'),
  monthlyContribution: money('monthly_contribution').default('0'),
  funding: jsonb('funding')
    .$type<import('../../shared/goals').GoalFunding>()
    .notNull()
    .default({ unassigned: '0', entries: [], purchases: [] }),
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  target: money('target'),
  saved: money('saved'),
  status: text('status').notNull(),
  priority: text('priority').notNull(),
  deadline: text('deadline'),
})
export const events = pgTable('events', {
  workspaceId: workspaceReference(),
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  date: text('date').notNull(),
  kind: text('kind').notNull(),
  amount: numeric('amount', { precision: 16, scale: 0 }),
  done: boolean('done').notNull().default(false),
  note: text('note').notNull(),
})
export const shopping = pgTable('shopping', {
  workspaceId: workspaceReference(),
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  quantity: text('quantity').notNull(),
  price: money('price'),
  checked: boolean('checked').notNull().default(false),
})
export const obligations = pgTable('obligations', {
  workspaceId: workspaceReference(),
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
    workspaceId: workspaceReference(),
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
  workspaceId: workspaceReference(),
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
export const workspaceGuard = pgTable('workspace_guard', {
  workspaceId: workspaceReference(),
  id: integer('id').primaryKey(),
  revision: numeric('revision', { precision: 20, scale: 0 }).notNull().default('0'),
})
export const commandHistory = pgTable('command_history', {
  workspaceId: workspaceReference(),
  id: text('id').primaryKey(),
  revision: numeric('revision', { precision: 20, scale: 0 }).notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
  actorUserId: text('actor_user_id'),
  actorName: text('actor_name'),
  operation: text('operation').notNull(),
  payload: jsonb('payload').$type<CommandHistoryEntry['payload']>().notNull(),
  result: jsonb('result').$type<CommandHistoryEntry['result']>().notNull(),
})
export const budgets = pgTable(
  'budgets',
  {
    workspaceId: workspaceReference(),
    id: text('id').primaryKey(),
    month: text('month').notNull(),
    category: text('category').notNull(),
    categoryId: categoryReference(),
    limit: money('limit'),
  },
  (t) => [uniqueIndex('budgets_month_category').on(t.month, t.category)],
)
const planFields = () => ({
  workspaceId: workspaceReference(),
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
    workspaceId: workspaceReference(),
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
