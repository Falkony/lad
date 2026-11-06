import { z } from 'zod'
import { localDate, toMinor } from './money'
import type { TransactionKind } from './types'
export interface ImportMapping {
  date: string
  amount: string
  description: string
  category: string
  externalId: string
  mode: 'signed' | 'expense' | 'income'
}
export interface ImportRow {
  kind: TransactionKind
  amount: string
  accountId: string
  toAccountId: null
  category: string
  description: string
  date: string
  importKey: string
}
export interface ImportPreview {
  rows: ImportRow[]
  errors: string[]
}
export function parseBankDate(value: string): string {
  const raw = value.trim().split(/[T ]/)[0] || ''
  const match = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(raw)
  const result = match ? `${match[3]}-${match[2]}-${match[1]}` : raw
  if (!z.iso.date().safeParse(result).success) throw new Error('неверная дата')
  return result
}
export async function previewImport(
  data: Record<string, string>[],
  mapping: ImportMapping,
  accountId: string,
): Promise<ImportPreview> {
  const rows: ImportRow[] = [],
    errors: string[] = [],
    occurrences = new Map<string, number>()
  for (let i = 0; i < data.length; i++) {
    try {
      const row = data[i]!
      const date = parseBankDate(row[mapping.date] || '')
      // The server rejects the whole import for one future row, so flag it here instead.
      if (date > localDate()) throw new Error('дата в будущем, такие платежи ведите в календаре')
      const raw = (row[mapping.amount] || '')
        .replace(/\s/g, '')
        .replace(/₽|руб\.?/gi, '')
        .replace(',', '.')
      if (!/^[+-]?\d+(\.\d{1,2})?$/.test(raw)) throw new Error('неверная сумма')
      const amount = toMinor(raw.replace(/^[+-]/, ''))
      if (BigInt(amount) === 0n) throw new Error('нулевая сумма')
      const kind =
        mapping.mode === 'signed' ? (raw.startsWith('-') ? 'expense' : 'income') : mapping.mode
      const description = (row[mapping.description] || '').trim().slice(0, 300)
      const category = (row[mapping.category] || 'Другое').trim().slice(0, 160) || 'Другое'
      const externalId = mapping.externalId ? row[mapping.externalId]?.trim() : ''
      const canonical = JSON.stringify([date, kind, amount, description.normalize('NFC')])
      const occurrence = occurrences.get(canonical) || 0
      occurrences.set(canonical, occurrence + 1)
      const source = externalId ? `bank-id:${externalId}` : `row:${canonical}:${occurrence}`
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
      const importKey = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('')
      rows.push({
        kind,
        amount,
        accountId,
        toAccountId: null,
        category,
        description,
        date,
        importKey,
      })
    } catch (error: any) {
      errors.push(`Строка ${i + 2}: ${error.message}`)
    }
  }
  return { rows, errors }
}
