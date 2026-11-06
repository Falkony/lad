import { z } from 'zod'
import type { Account, Transaction } from './types'
import { accountBalance } from './money'
const minor = z
  .string()
  .regex(/^\d{1,16}$/)
  .refine((v) => BigInt(v) <= 9000000000000000n)
export const creditSettingsSchema = z.object({
  limit: minor.default('0'),
  minimumPayment: minor.default('0'),
  paymentDay: z.number().int().min(1).max(31).default(20),
  graceUntil: z.iso.date().nullable().default(null),
  payerAccountId: z.uuid().nullable().default(null),
  payFull: z.boolean().default(true),
})
export type CreditSettings = z.infer<typeof creditSettingsSchema>
export const creditLimit = (account: Account) =>
  account.kind === 'credit' ? BigInt(account.creditSettings?.limit || '0') : 0n
export function creditState(account: Account, transactions: Transaction[]) {
  const balance = BigInt(accountBalance(account, transactions)),
    limit = creditLimit(account),
    debt = balance < 0n ? -balance : 0n
  const minimum = BigInt(account.creditSettings?.minimumPayment || '0')
  return {
    balance,
    limit,
    debt,
    available: limit + balance,
    payment: account.creditSettings?.payFull ? debt : minimum < debt ? minimum : debt,
  }
}
