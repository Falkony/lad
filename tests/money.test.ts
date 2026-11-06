import { describe, expect, it } from 'vitest'
import { toMinor, toSignedMinor, sumAmounts, accountBalance } from '../shared/money'
import { transactionSchema } from '../shared/schemas'
import type { Account, Transaction } from '../shared/types'
describe('money and ledger invariants', () => {
  it('normalizes signed balances precisely and rejects malformed input', () => {
    expect(toSignedMinor('-123,45')).toBe('-12345')
    expect(toSignedMinor('+0.10')).toBe('10')
    expect(toSignedMinor('-0')).toBe('0')
    expect(() => toSignedMinor('--1')).toThrow()
  })
  it('parses localized decimals without binary floating point errors', () => {
    expect(toMinor('1 234,56')).toBe('123456')
    expect(sumAmounts([toMinor('0.10'), toMinor('0.20')])).toBe('30')
    expect(() => toMinor('12.345')).toThrow()
    expect(() => toMinor('-15')).toThrow()
    expect(() => toMinor('1e3')).toThrow()
  })
  it('preserves amounts above JS safe integer when summing', () => {
    expect(sumAmounts(['9000000000000000', '9000000000000000', '1'])).toBe('18000000000000001')
  })
  it('a transfer changes individual balances but preserves the total', () => {
    const a = { id: 'a', openingBalance: '10000' } as Account
    const b = { id: 'b', openingBalance: '5000' } as Account
    const txs = [
      { kind: 'transfer', amount: '2500', accountId: 'a', toAccountId: 'b' },
    ] as Transaction[]
    expect(accountBalance(a, txs)).toBe('7500')
    expect(accountBalance(b, txs)).toBe('7500')
    expect(sumAmounts([accountBalance(a, txs), accountBalance(b, txs)])).toBe('15000')
  })
  it('rejects self transfers, invalid dates and zero amounts', () => {
    const id = crypto.randomUUID()
    const base = {
      kind: 'expense',
      amount: '150',
      accountId: id,
      category: 'Дом',
      date: '2026-01-01',
    }
    expect(transactionSchema.safeParse(base).success).toBe(true)
    expect(
      transactionSchema.safeParse({ ...base, kind: 'transfer', toAccountId: id }).success,
    ).toBe(false)
    expect(transactionSchema.safeParse({ ...base, date: '2026-02-30' }).success).toBe(false)
    expect(transactionSchema.safeParse({ ...base, amount: '0' }).success).toBe(false)
    expect(transactionSchema.safeParse({ ...base, date: '2099-01-01' }).success).toBe(false)
  })
})
