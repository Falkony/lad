import { z } from 'zod'
import { amount, positiveAmount } from './schemas'
export const monthSchema = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/, 'Выберите месяц')
export const budgetSchema = z.object({
  month: monthSchema,
  category: z.string().trim().min(1).max(160),
  limit: amount,
})
export const recurringSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    category: z.string().trim().min(1).max(160),
    amount: positiveAmount,
    accountId: z.uuid().nullable().default(null),
    frequency: z.enum(['monthly', 'weekly', 'yearly']),
    interval: z.number().int().min(1).max(12).default(1),
    startDate: z.iso.date(),
    endDate: z.iso.date().nullable().default(null),
    note: z.string().trim().max(1000).default(''),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: 'Дата окончания должна быть не раньше первого платежа',
    path: ['endDate'],
  })
export const recurringVersionSchema = z
  .object({
    ...recurringSchema.shape,
    id: z.uuid(),
    recurringId: z.uuid(),
    validFrom: z.iso.date(),
    validTo: z.iso.date().nullable(),
  })
  .refine(
    (v) => (!v.endDate || v.endDate >= v.startDate) && (!v.validTo || v.validTo >= v.validFrom),
    'Неверный период расписания',
  )
export const occurrenceSchema = z
  .object({
    id: z.uuid(),
    recurringId: z.uuid(),
    dueDate: z.iso.date(),
    title: z.string().min(1).max(160),
    category: z.string().min(1).max(160),
    amount: positiveAmount,
    accountId: z.uuid().nullable(),
    note: z.string().max(1000),
    status: z.enum(['pending', 'paid', 'skipped']),
    transactionId: z.uuid().nullable(),
  })
  .refine(
    (v) => (v.status === 'paid') === (v.transactionId !== null),
    'Оплаченный платёж должен ссылаться на расход',
  )
