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
  id: string
  name: string
  kind: string
  openingBalance: string
  color: string
  bankName: string
  last4: string
  archived: boolean
}
export interface Transaction {
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
export interface Obligation {
  id: string
  title: string
  kind: string
  remaining: string
  payment: string
  dueDay: number
  rate: string
}
export interface Workspace {
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
  isDemo: boolean
  revision: string
}
