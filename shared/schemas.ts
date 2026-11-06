import { z } from 'zod'
import { localDate } from './money'
z.config(z.locales.ru())
export const amount = z
  .string()
  .regex(/^\d{1,16}$/)
  .refine((v) => /^\d+$/.test(v) && BigInt(v) <= 9000000000000000n, 'Слишком большая сумма')
export const signedAmount = z
  .string()
  .regex(/^-?\d{1,16}$/)
  .refine(
    (v) => /^-?\d+$/.test(v) && (BigInt(v) < 0n ? -BigInt(v) : BigInt(v)) <= 9000000000000000n,
    'Слишком большая сумма',
  )
export const positiveAmount = amount.refine(
  (v) => /^\d+$/.test(v) && BigInt(v) > 0n,
  'Сумма должна быть больше нуля',
)
const date = z.iso.date()
/** A date not later than today: recorded money movements cannot happen in the future. */
export const pastDate = (message = 'Будущие операции добавляйте в календарь') =>
  date.refine((value) => value <= localDate(), message)
export const revision = z.string().regex(/^\d{1,20}$/)
const title = z.string().trim().min(1).max(160)
export const accountSchema = z.object({
  name: title,
  kind: z.enum(['card', 'cash', 'savings']).default('card'),
  openingBalance: signedAmount,
  color: z.enum(['green', 'blue', 'sand']).default('green'),
  bankName: z.string().trim().max(80).default(''),
  last4: z
    .string()
    .regex(/^(\d{4})?$/, 'Укажите четыре цифры')
    .default(''),
  /** Omitted: savings stay outside the forecast on create, the stored value is kept on update. */
  inForecast: z.boolean().optional(),
})
export const transactionSchema = z
  .object({
    kind: z.enum(['expense', 'income', 'transfer']),
    amount: positiveAmount,
    accountId: z.uuid(),
    toAccountId: z.uuid().nullable().default(null),
    category: title,
    description: z.string().trim().max(300).default(''),
    date: pastDate(),
    importKey: z.string().max(300).nullable().default(null),
  })
  .refine((v) => v.kind !== 'transfer' || (v.toAccountId && v.toAccountId !== v.accountId), {
    message: 'Выберите другой счёт для перевода',
    path: ['toAccountId'],
  })
export const goalSchema = z.object({
  title,
  target: positiveAmount,
  saved: amount,
  status: z.enum(['wish', 'saving', 'planned', 'done']).default('wish'),
  priority: z.enum(['normal', 'high']).default('normal'),
  deadline: date.nullable().default(null),
})
export const eventSchema = z.object({
  title,
  date,
  // Payments and incomes are plans (planning-schemas.ts); the calendar keeps tasks and notes.
  kind: z.enum(['task', 'note']).default('task'),
  amount: z.null().default(null),
  done: z.boolean().default(false),
  note: z.string().max(1000).default(''),
})
export const shoppingSchema = z.object({
  title,
  quantity: z.string().trim().min(1).max(40).default('1 шт.'),
  price: amount.default('0'),
  checked: z.boolean().default(false),
})
export const obligationSchema = z.object({
  title,
  kind: z.enum(['credit', 'mortgage', 'debt', 'receivable']),
  openingBalance: amount,
  startDate: date,
  accountId: z.uuid().nullable().default(null),
  payment: amount,
  dueDay: z.number().int().min(1).max(31),
  rate: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3})?$/)
    .default('0'),
})
export const importSchema = z.object({ transactions: z.array(transactionSchema).min(1).max(2000) })
