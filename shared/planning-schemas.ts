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
  customDates: z
    .array(z.object({ date: z.iso.date(), amount: positiveAmount }))
    .max(1200)
    .default([])
    .refine((rows) => new Set(rows.map((r) => r.date)).size === rows.length, 'Даты повторяются'),
  title: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(160),
  amount: positiveAmount,
  accountId: z.uuid().nullable().default(null),
  frequency: z.enum(['once', 'monthly', 'weekly', 'yearly', 'custom']),
  interval: z.number().int().min(1).max(12).default(1),
  startDate: z.iso.date(),
  endDate: z.iso.date().nullable().default(null),
  note: z.string().trim().max(1000).default(''),
  monthDays: z
    .array(z.number().int().min(1).max(31))
    .max(4)
    .default([])
    .transform((days) => [...days].sort((a, b) => a - b)),
  holidayShift: z.enum(['none', 'before']).default('none'),
}
type PlanShape = {
  frequency: string
  interval: number
  startDate: string
  endDate: string | null
  monthDays: number[]
}
const validPeriod = (v: PlanShape) => !v.endDate || v.endDate >= v.startDate
const validOnce = (v: PlanShape) => v.frequency !== 'once' || (v.interval === 1 && !v.endDate)
const validDays = (v: PlanShape) =>
  !v.monthDays.length ||
  (v.frequency === 'monthly' && new Set(v.monthDays).size === v.monthDays.length)
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
  .refine(validDays, {
    message: 'Несколько дней выплаты бывают только у ежемесячного плана, без повторов',
    path: ['monthDays'],
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
    (v) =>
      validPeriod(v) && validOnce(v) && validDays(v) && (!v.validTo || v.validTo >= v.validFrom),
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
