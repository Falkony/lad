import { z } from 'zod'
import { amount, positiveAmount } from './schemas'
export const monthSchema = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/, 'Выберите месяц')
export const budgetSchema = z.object({
  month: monthSchema,
  category: z.string().trim().min(1).max(160),
  limit: amount,
})
export const directionSchema = z.enum(['expense', 'income'])
const planShape = {
  title: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(160),
  amount: positiveAmount,
  accountId: z.uuid().nullable().default(null),
  frequency: z.enum(['once', 'monthly', 'weekly', 'yearly']),
  interval: z.number().int().min(1).max(12).default(1),
  startDate: z.iso.date(),
  endDate: z.iso.date().nullable().default(null),
  note: z.string().trim().max(1000).default(''),
}
type PlanShape = { frequency: string; interval: number; startDate: string; endDate: string | null }
const validPeriod = (v: PlanShape) => !v.endDate || v.endDate >= v.startDate
const validOnce = (v: PlanShape) => v.frequency !== 'once' || (v.interval === 1 && !v.endDate)
export const planSchema = z
  .object(planShape)
  .refine(validPeriod, {
    message: 'Дата окончания должна быть не раньше первой даты',
    path: ['endDate'],
  })
  .refine(validOnce, {
    message: 'У разового плана нет повторов и даты окончания',
    path: ['frequency'],
  })
export const planVersionSchema = z
  .object({
    ...planShape,
    id: z.uuid(),
    planId: z.uuid(),
    validFrom: z.iso.date(),
    validTo: z.iso.date().nullable(),
  })
  .refine(
    (v) => validPeriod(v) && validOnce(v) && (!v.validTo || v.validTo >= v.validFrom),
    'Неверный период плана',
  )
export const occurrenceSchema = z
  .object({
    id: z.uuid(),
    planId: z.uuid(),
    dueDate: z.iso.date(),
    title: z.string().min(1).max(160),
    category: z.string().min(1).max(160),
    amount: positiveAmount,
    accountId: z.uuid().nullable(),
    note: z.string().max(1000),
    status: z.enum(['pending', 'paid', 'skipped', 'closed']),
    transactionId: z.uuid().nullable(),
    movedTo: z.iso.date().nullable().default(null),
  })
  .refine(
    (v) => (v.status === 'paid') === (v.transactionId !== null),
    'Подтверждённая дата должна ссылаться на операцию',
  )
