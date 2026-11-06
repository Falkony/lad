export const categories = [
  'Продукты',
  'Дом',
  'Транспорт',
  'Здоровье',
  'Развлечения',
  'Покупки',
  'Кафе',
  'Подписки',
  'Зарплата',
  'Другое',
] as const
export type TransactionKind = 'expense' | 'income' | 'transfer' | 'adjustment'
export interface Account {
  /** Client period projection only: editable opening value remains the original. */
  originalOpeningBalance?: string
  creditSettings?: import('./credit').CreditSettings
  id: string
  name: string
  kind: string
  openingBalance: string
  color: string
  bankName: string
  last4: string
  archived: boolean
  /** Takes part in the money forecast; savings stay outside by default. */
  inForecast: boolean
}
export interface Transaction {
  categoryId?: string
  splits?: import('./transaction-details').TransactionSplit[]
  refundOf?: string | null
  id: string
  kind: TransactionKind
  amount: string
  accountId: string
  toAccountId: string | null
  category: string
  description: string
  date: string
  importKey: string | null
  importAccountId: string | null
  createdAt: string
  deletedAt: string | null
}
export interface Goal {
  funding?: import('./goals').GoalFunding
  mandatory?: boolean
  categoryId?: string | null
  purchaseMonth?: string | null
  monthlyContribution?: string
  id: string
  title: string
  target: string
  saved: string
  status: string
  priority: string
  deadline: string | null
}
export interface CalendarEvent {
  id: string
  title: string
  date: string
  kind: string
  amount: string | null
  done: boolean
  note: string
}
export interface ShoppingItem {
  id: string
  title: string
  quantity: string
  price: string
  checked: boolean
}
export type ObligationKind = 'credit' | 'mortgage' | 'debt' | 'receivable'
export interface Obligation {
  bankSchedule?: { date: string; amount: string; interest?: string }[]
  interestMethod?: 'monthly' | 'actual365'
  id: string
  title: string
  kind: ObligationKind
  /** The principal on `startDate`; the current balance is computed from the entries. */
  openingBalance: string
  startDate: string
  /** Account the payments are usually made from (or a returned debt is received to). */
  accountId: string | null
  payment: string
  dueDay: number
  rate: string
}
export type EarlyRepayment = 'none' | 'term' | 'payment'
/**
 * A repayment split into principal, interest and fees and linked to its transaction, or a
 * reconciliation with the bank (`adjustment`: a signed change of the principal, no transaction).
 */
export interface ObligationEntry {
  id: string
  obligationId: string
  kind: 'payment' | 'adjustment'
  date: string
  principal: string
  interest: string
  fees: string
  transactionId: string | null
  /** An early repayment shortens the term or lowers the monthly payment. */
  early: EarlyRepayment
  /** The monthly payment before an early repayment lowered it: restored when it is cancelled. */
  previousPayment: string | null
  note: string
  createdAt: string
}
export interface Workspace {
  budgetHistory?: import('./periods').BudgetChange[]
  reconciliations?: import('./periods').Reconciliation[]
  periodClosures?: import('./periods').PeriodClosure[]
  importBatches?: import('./import-workflow').ImportBatch[]
  importRules?: import('./import-workflow').ImportRule[]
  importTemplates?: import('./import-workflow').ImportTemplate[]
  importKeys?: import('./import-workflow').ImportKey[]
  transactionRange?: { from: string; to: string }
  referenceTransactions?: Transaction[]
  activeTransactionIds?: string[]
  categories?: import('./categories').Category[]
  timeZone?: string
  budgets: import('./planning-types').Budget[]
  plans: import('./planning-types').Plan[]
  planVersions: import('./planning-types').PlanVersion[]
  planOccurrences: import('./planning-types').PlanOccurrence[]
  accounts: Account[]
  transactions: Transaction[]
  deletedTransactions: Transaction[]
  goals: Goal[]
  events: CalendarEvent[]
  shopping: ShoppingItem[]
  obligations: Obligation[]
  obligationEntries: ObligationEntry[]
  isDemo: boolean
  revision: string
}
