import { describe, it, expect } from 'vitest'
import { previewImport, parseBankDate, type ImportMapping } from '../shared/import'
const mapping: ImportMapping = {
  date: 'Дата',
  amount: 'Сумма',
  description: 'Описание',
  category: '',
  externalId: '',
  mode: 'signed',
}
describe('statement normalization', () => {
  it('normalizes dates without timezone shifts', () => {
    expect(parseBankDate('05.11.2026 14:30')).toBe('2026-11-05')
    expect(() => parseBankDate('31.02.2026')).toThrow()
  })
  it('preserves identical real transactions while making reimports idempotent', async () => {
    const input = Array.from({ length: 2 }, () => ({
      Дата: '01.11.2026',
      Сумма: '-120,50',
      Описание: 'Кофе',
    }))
    const a = await previewImport(input, mapping, 'account'),
      b = await previewImport(input, mapping, 'account')
    expect(a.errors).toEqual([])
    expect(a.rows).toHaveLength(2)
    expect(a.rows[0]!.amount).toBe('12050')
    expect(a.rows[0]!.kind).toBe('expense')
    expect(a.rows[0]!.importKey).not.toBe(a.rows[1]!.importKey)
    expect(a.rows.map((x) => x.importKey)).toEqual(b.rows.map((x) => x.importKey))
  })
  it('uses stable bank IDs across differently ordered exports', async () => {
    const m = { ...mapping, externalId: 'ID' }
    const a = await previewImport(
      [{ Дата: '01.11.2026', Сумма: '-15', Описание: 'A', ID: '42' }],
      m,
      'account',
    )
    const b = await previewImport(
      [{ Дата: '02.11.2026', Сумма: '-15', Описание: 'Changed description', ID: '42' }],
      m,
      'account',
    )
    expect(a.rows[0]!.importKey).toBe(b.rows[0]!.importKey)
  })
  it('reports invalid lines and supports explicitly unsigned expenses', async () => {
    const result = await previewImport(
      [
        { Дата: '01.11.2026', Сумма: '100', Описание: '' },
        { Дата: 'bad', Сумма: '22', Описание: '' },
      ],
      { ...mapping, mode: 'expense' },
      'account',
    )
    expect(result.rows[0]!.kind).toBe('expense')
    expect(result.errors[0]).toContain('Строка 3')
  })
})
