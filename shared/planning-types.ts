export interface Budget {
  id: string
  month: string
  category: string
  limit: string
}
export interface RecurringFields {
  title: string
  category: string
  amount: string
  accountId: string | null
  frequency: 'monthly' | 'weekly' | 'yearly'
  interval: number
  startDate: string
  endDate: string | null
  note: string
}
export interface RecurringPayment extends RecurringFields {
  id: string
  active: boolean
}
export interface RecurringVersion extends RecurringFields {
  id: string
  recurringId: string
  validFrom: string
  validTo: string | null
}
export interface PaymentOccurrence {
  id: string
  recurringId: string
  dueDate: string
  title: string
  category: string
  amount: string
  accountId: string | null
  note: string
  status: 'pending' | 'paid' | 'skipped'
  transactionId: string | null
}
export interface ProjectedPayment extends Omit<PaymentOccurrence, 'status'> {
  status: 'pending' | 'paid' | 'skipped' | 'deleted'
  actualAmount: string | null
  actualDate: string | null
}
export interface CommandResult {
  ok?: boolean
  imported?: number
  skipped?: number
  copied?: number
  transactionId?: string
  alreadyPaid?: boolean
}
