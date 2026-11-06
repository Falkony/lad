import { dateInTimeZone } from './time-zone'
import Decimal from 'decimal.js'
import type { Account, Transaction } from './types'

export function toMinor(input: string): string {
  const normalized = input.replace(/\s/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error('Введите сумму с точностью до копеек')
  const value = new Decimal(normalized).times(100)
  if (value.greaterThan('9000000000000000')) throw new Error('Слишком большая сумма')
  return value.toFixed(0)
}
export function toMajor(input: string): string {
  return new Decimal(input).div(100).toFixed(2)
}
export function toSignedMinor(input: string): string {
  const normalized = input.trim().replace(/\s/g, '')
  const value = toMinor(normalized.replace(/^[+-]/, ''))
  return (normalized.startsWith('-') ? -BigInt(value) : BigInt(value)).toString()
}
export function money(input: string | bigint, compact = false): string {
  const value = new Decimal(input.toString()).div(100).toNumber()
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: compact ? 0 : 2,
    minimumFractionDigits: 0,
  }).format(value)
}
export function sumAmounts(values: string[]): string {
  return values.reduce((sum, v) => sum + BigInt(v), 0n).toString()
}
export function accountBalance(account: Account, transactions: Transaction[]): string {
  return transactions
    .reduce((balance, t) => {
      if (t.deletedAt) return balance
      if (t.accountId === account.id)
        balance +=
          t.kind === 'income' || t.kind === 'adjustment' ? BigInt(t.amount) : -BigInt(t.amount)
      if (t.kind === 'transfer' && t.toAccountId === account.id) balance += BigInt(t.amount)
      return balance
    }, BigInt(account.openingBalance))
    .toString()
}
export function localDate(date = new Date()): string {
  return dateInTimeZone(date)
}
