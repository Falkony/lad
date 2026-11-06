export interface Budget {
  id: string
  month: string
  category: string
  limit: string
}
export type PlanDirection = 'expense' | 'income'
export type PlanFrequency = 'once' | 'monthly' | 'weekly' | 'yearly' | 'custom'
export type PlanSource = 'manual' | 'obligation' | 'goal' | 'credit'
export type HolidayShift = 'none' | 'before'
export interface PlanFields {
  customDates?: { date: string; amount: string }[]
  title: string
  category: string
  amount: string
  accountId: string | null
  frequency: PlanFrequency
  interval: number
  startDate: string
  endDate: string | null
  note: string
  /** Days of the month for a monthly plan (salary on the 5th and the 20th); empty: the day of `startDate`. */
  monthDays: number[]
  /** `before`: a date on a weekend or holiday moves to the previous working day (Labour Code, art. 136). */
  holidayShift: HolidayShift
}
/** A planned income or payment: one-off (`frequency: 'once'`) or recurring. */
export interface Plan extends PlanFields {
  id: string
  active: boolean
  direction: PlanDirection
  source: PlanSource
  sourceId: string | null
}
/** Settings of a plan for a period; editing a recurring plan closes one version and opens another. */
export interface PlanVersion extends PlanFields {
  id: string
  planId: string
  validFrom: string
  validTo: string | null
}
export type OccurrenceStatus = 'pending' | 'paid' | 'skipped' | 'closed'
/**
 * A decision about one scheduled date, keyed by the plan and its original date (`dueDate`):
 * confirmation (paid), cancellation (skipped), a move (`movedTo`) or a changed amount (pending).
 * `closed` marks legacy calendar payments that were ticked off without a recorded transaction.
 */
export interface PlanOccurrence {
  id: string
  planId: string
  dueDate: string
  title: string
  category: string
  amount: string
  accountId: string | null
  note: string
  status: OccurrenceStatus
  transactionId: string | null
  movedTo: string | null
}
export interface ProjectedOccurrence extends Omit<PlanOccurrence, 'status'> {
  source?: PlanSource
  creditAccountId?: string | null
  /** `deleted`: confirmed, but the linked transaction was deleted afterwards. */
  status: OccurrenceStatus | 'deleted'
  direction: PlanDirection
  frequency: PlanFrequency
  /** The effective date: `movedTo` when the date was moved, otherwise `dueDate`. */
  date: string
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
