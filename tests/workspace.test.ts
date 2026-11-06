import { beforeAll, describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeCommand, readWorkspace, commandSchema } from '../server/modules/workspace'
import { localDate } from '../shared/money'
beforeAll(async () => {
  process.env.LAD_DATA_DIR = join(await mkdtemp(join(tmpdir(), 'lad-test-')), 'nested', 'db')
  delete process.env.DATABASE_URL
})
const run = (value: unknown) => executeCommand(commandSchema.parse(value))
describe('persistent workspace', () => {
  let accountId: string
  it('starts empty and persists a new account', async () => {
    expect((await readWorkspace()).accounts).toEqual([])
    await run({ op: 'account.create', data: { name: 'Тестовый счёт', openingBalance: '100000' } })
    accountId = (await readWorkspace()).accounts[0]!.id
    expect(accountId).toBeTruthy()
  })
  it('atomically records checkout and removes only purchased goods', async () => {
    await run({ op: 'shopping.create', data: { title: 'Молоко', price: '15000', checked: true } })
    await run({ op: 'shopping.create', data: { title: 'Хлеб', price: '10000', checked: false } })
    await run({ op: 'shopping.checkout', data: { accountId, amount: '15000', date: localDate() } })
    const state = await readWorkspace()
    expect(state.shopping.map((x) => x.title)).toEqual(['Хлеб'])
    expect(state.transactions[0]!.amount).toBe('15000')
    expect(state.transactions[0]!.category).toBe('Продукты')
  })
  it('rolls back a failed checkout', async () => {
    await run({ op: 'shopping.create', data: { title: 'Яйца', price: '17000', checked: true } })
    await expect(
      run({
        op: 'shopping.checkout',
        data: { accountId: crypto.randomUUID(), amount: '17000', date: localDate() },
      }),
    ).rejects.toThrow()
    const state = await readWorkspace()
    expect(state.transactions).toHaveLength(1)
    expect(state.shopping.some((x) => x.title === 'Яйца' && x.checked)).toBe(true)
  })
  it('skips re-imports and rolls back imports with invalid accounts', async () => {
    const row = {
      kind: 'expense',
      amount: '250',
      accountId,
      category: 'Другое',
      date: localDate(),
      importKey: 'test-1',
    }
    expect(await run({ op: 'import', data: { transactions: [row] } })).toEqual({
      imported: 1,
      skipped: 0,
    })
    expect(await run({ op: 'import', data: { transactions: [row] } })).toEqual({
      imported: 0,
      skipped: 1,
    })
    await expect(
      run({
        op: 'import',
        data: {
          transactions: [
            { ...row, importKey: 'test-2' },
            { ...row, importKey: 'test-3', accountId: crypto.randomUUID() },
          ],
        },
      }),
    ).rejects.toThrow()
    expect((await readWorkspace()).transactions).toHaveLength(2)
  })
  it('does not mix demo records with existing personal records', async () => {
    await expect(run({ op: 'demo.load' })).rejects.toThrow()
    expect((await readWorkspace()).isDemo).toBe(false)
  })
  it('updates an opening balance without changing recorded operations', async () => {
    await run({
      op: 'account.update',
      id: accountId,
      data: { name: 'Карта', openingBalance: '120000' },
    })
    const state = await readWorkspace()
    expect(state.accounts[0]!.openingBalance).toBe('120000')
    expect(state.transactions).toHaveLength(2)
  })
  it('supports updating a debt to a fully repaid balance', async () => {
    await run({
      op: 'obligation.create',
      data: { title: 'Долг', kind: 'debt', remaining: '10000', payment: '1000', dueDay: 10 },
    })
    const obligation = (await readWorkspace()).obligations[0]!
    await run({
      op: 'obligation.update',
      id: obligation.id,
      data: { ...obligation, remaining: '0' },
    })
    expect((await readWorkspace()).obligations[0]!.remaining).toBe('0')
  })
  it('requires explicit reset confirmation', () => {
    expect(commandSchema.safeParse({ op: 'workspace.reset', confirmation: '' }).success).toBe(false)
  })
})
