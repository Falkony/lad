import { eq, desc, sql, or, inArray } from 'drizzle-orm'
import { createError } from 'h3'
import { z } from 'zod'
import { getDb } from '../db'
import {
  accounts,
  transactions,
  goals,
  events,
  shopping,
  obligations,
  settings,
  workspaceGuard,
  budgets,
  recurringPayments,
  recurringVersions,
  paymentOccurrences,
} from '../db/schema'
import {
  accountSchema,
  transactionSchema,
  goalSchema,
  eventSchema,
  shoppingSchema,
  obligationSchema,
  importSchema,
  signedAmount,
} from '../../shared/schemas'
import { localDate, accountBalance } from '../../shared/money'
import { backupSchema } from '../../shared/backup'
import type { Account, Transaction } from '../../shared/types'
import type { Workspace } from '../../shared/types'
import type { CommandResult } from '../../shared/planning-types'
import { planningCommands, isPlanningCommand, executePlanningCommand } from './planning'

export async function readWorkspace(): Promise<Workspace> {
  const client = await getDb()
  return client.transaction(
    async (db) => {
      const [a, t, g, e, s, o, meta, guard, b, r, v, p] = await Promise.all([
        db.select().from(accounts).orderBy(accounts.name, accounts.id),
        db
          .select()
          .from(transactions)
          .orderBy(desc(transactions.date), desc(transactions.createdAt)),
        db.select().from(goals),
        db.select().from(events),
        db.select().from(shopping),
        db.select().from(obligations),
        db.select().from(settings),
        db.select().from(workspaceGuard),
        db.select().from(budgets),
        db.select().from(recurringPayments).orderBy(recurringPayments.title),
        db.select().from(recurringVersions),
        db.select().from(paymentOccurrences),
      ])
      return {
        accounts: a,
        transactions: t.filter((t) => !t.deletedAt),
        deletedTransactions: t.filter((t) => t.deletedAt),
        goals: g,
        events: e,
        shopping: s,
        obligations: o,
        isDemo: meta.some((x) => x.key === 'demo' && x.value === 'true'),
        revision: guard[0]!.revision,
        budgets: b,
        recurringPayments: r,
        recurringVersions: v,
        paymentOccurrences: p,
      } as Workspace
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

export const commandSchema = z.discriminatedUnion('op', [
  ...planningCommands,
  z.object({ op: z.literal('account.create'), data: accountSchema }),
  z.object({ op: z.literal('account.update'), id: z.uuid(), data: accountSchema }),
  z.object({ op: z.literal('account.archive'), id: z.uuid(), archived: z.boolean() }),
  z.object({ op: z.literal('account.delete'), id: z.uuid() }),
  z.object({
    op: z.literal('account.reconcile'),
    id: z.uuid(),
    data: z.object({
      date: z.iso.date().refine((d) => d <= localDate(), 'Нельзя сверить будущую дату'),
      targetBalance: signedAmount,
      expectedBalance: signedAmount,
      note: z.string().trim().max(260).default(''),
    }),
  }),
  z.object({ op: z.literal('transaction.create'), data: transactionSchema }),
  z.object({ op: z.literal('transaction.update'), id: z.uuid(), data: transactionSchema }),
  z.object({ op: z.literal('transaction.delete'), id: z.uuid() }),
  z.object({ op: z.literal('transaction.restore'), id: z.uuid() }),
  z.object({
    op: z.literal('transactions.categorize'),
    ids: z.array(z.uuid()).min(1).max(2000),
    category: z.string().trim().min(1).max(160),
  }),
  z.object({
    op: z.literal('workspace.restore'),
    backup: backupSchema,
    expectedRevision: z.string().regex(/^\d{1,20}$/),
    confirmation: z.literal('ВОССТАНОВИТЬ'),
  }),
  z.object({ op: z.literal('goal.create'), data: goalSchema }),
  z.object({ op: z.literal('goal.update'), id: z.uuid(), data: goalSchema }),
  z.object({ op: z.literal('goal.delete'), id: z.uuid() }),
  z.object({ op: z.literal('event.create'), data: eventSchema }),
  z.object({ op: z.literal('event.toggle'), id: z.uuid(), done: z.boolean() }),
  z.object({ op: z.literal('event.delete'), id: z.uuid() }),
  z.object({ op: z.literal('shopping.create'), data: shoppingSchema }),
  z.object({ op: z.literal('shopping.toggle'), id: z.uuid(), checked: z.boolean() }),
  z.object({ op: z.literal('shopping.delete'), id: z.uuid() }),
  z.object({
    op: z.literal('shopping.checkout'),
    data: z.object({
      accountId: z.uuid(),
      amount: z
        .string()
        .regex(/^\d{1,16}$/)
        .refine((v) => BigInt(v) > 0n && BigInt(v) <= 9000000000000000n),
      date: z.iso.date(),
    }),
  }),
  z.object({ op: z.literal('obligation.create'), data: obligationSchema }),
  z.object({ op: z.literal('obligation.update'), id: z.uuid(), data: obligationSchema }),
  z.object({ op: z.literal('obligation.delete'), id: z.uuid() }),
  z.object({ op: z.literal('import'), data: importSchema }),
  z.object({ op: z.literal('demo.load') }),
  z.object({ op: z.literal('workspace.reset'), confirmation: z.literal('УДАЛИТЬ') }),
])
export type Command = z.infer<typeof commandSchema>

export async function executeCommand(command: Command) {
  if (command.op === 'demo.load') {
    await seedDemo()
    return { ok: true }
  }
  const client = await getDb()
  return client.transaction(async (db) => {
    const [guard] = await db
      .select()
      .from(workspaceGuard)
      .where(eq(workspaceGuard.id, 1))
      .for('update')
    if (isPlanningCommand(command)) {
      const result = await executePlanningCommand(db, command, guard!.revision)
      await db
        .update(workspaceGuard)
        .set({ revision: sql`${workspaceGuard.revision} + 1` })
        .where(eq(workspaceGuard.id, 1))
      return result
    }
    let result: CommandResult = { ok: true }
    switch (command.op) {
      case 'account.create':
        await db.insert(accounts).values({ id: crypto.randomUUID(), ...command.data })
        break
      case 'account.update': {
        const [account] = await db.select().from(accounts).where(eq(accounts.id, command.id))
        if (!account) throw createError({ statusCode: 404, message: 'Счёт не найден' })
        await db.update(accounts).set(command.data).where(eq(accounts.id, command.id))
        break
      }
      case 'account.archive': {
        const result = await db
          .update(accounts)
          .set({ archived: command.archived })
          .where(eq(accounts.id, command.id))
          .returning()
        if (!result.length) throw createError({ statusCode: 404, message: 'Счёт не найден' })
        break
      }
      case 'account.delete': {
        const references = await Promise.all([
          db
            .select()
            .from(recurringPayments)
            .where(eq(recurringPayments.accountId, command.id))
            .limit(1),
          db
            .select()
            .from(recurringVersions)
            .where(eq(recurringVersions.accountId, command.id))
            .limit(1),
          db
            .select()
            .from(paymentOccurrences)
            .where(eq(paymentOccurrences.accountId, command.id))
            .limit(1),
        ])
        if (references.some((rows) => rows.length))
          throw createError({
            statusCode: 409,
            message: 'Счёт связан с расписанием платежей. Используйте архив.',
          })
        const history = await db
          .select()
          .from(transactions)
          .where(
            or(
              eq(transactions.accountId, command.id),
              eq(transactions.toAccountId, command.id),
              eq(transactions.importAccountId, command.id),
            ),
          )
          .limit(1)
        if (history.length)
          throw createError({
            statusCode: 409,
            message: 'У счёта есть история, включая удалённые операции. Используйте архив.',
          })
        const [account] = await db.select().from(accounts).where(eq(accounts.id, command.id))
        if (!account) throw createError({ statusCode: 404, message: 'Счёт не найден' })
        if (BigInt(account.openingBalance) !== 0n)
          throw createError({
            statusCode: 409,
            message:
              'У счёта ненулевой остаток. Используйте архив или исправьте начальный остаток.',
          })
        await db.delete(accounts).where(eq(accounts.id, command.id))
        break
      }
      case 'account.reconcile': {
        const [account] = await db.select().from(accounts).where(eq(accounts.id, command.id))
        if (!account || account.archived)
          throw createError({ statusCode: 400, message: 'Выберите действующий счёт' })
        const history = await db.select().from(transactions)
        const actual = accountBalance(
          account as Account,
          history.filter((t) => t.date <= command.data.date) as Transaction[],
        )
        if (actual !== command.data.expectedBalance)
          throw createError({
            statusCode: 409,
            message: 'Остаток изменился. Обновите данные и повторите сверку.',
          })
        const delta = BigInt(command.data.targetBalance) - BigInt(actual)
        if (delta !== 0n) {
          if ((delta < 0n ? -delta : delta) > 9000000000000000n)
            throw createError({ statusCode: 400, message: 'Слишком большая корректировка' })
          await db.insert(transactions).values({
            id: crypto.randomUUID(),
            kind: 'adjustment',
            amount: delta.toString(),
            accountId: account.id,
            category: 'Корректировка',
            description: command.data.note || 'Сверка остатка с банком',
            date: command.data.date,
          })
        }
        break
      }
      case 'transaction.create':
      case 'transaction.update': {
        const previous =
          command.op === 'transaction.update'
            ? (await db.select().from(transactions).where(eq(transactions.id, command.id)))[0]
            : undefined
        if (command.op === 'transaction.update' && (!previous || previous.deletedAt))
          throw createError({ statusCode: 404, message: 'Операция не найдена' })
        if (previous?.kind === 'adjustment')
          throw createError({
            statusCode: 400,
            message: 'Корректировка создана сверкой. Для изменения выполните новую сверку.',
          })
        if (previous && command.data.kind !== 'expense') {
          const linked = await db
            .select()
            .from(paymentOccurrences)
            .where(eq(paymentOccurrences.transactionId, previous.id))
            .limit(1)
          if (linked.length)
            throw createError({
              statusCode: 409,
              message: 'Операция связана с платежом календаря и должна оставаться расходом',
            })
        }
        const knownAccounts = await db.select().from(accounts)
        const allowed = (id: string | null) =>
          knownAccounts.some(
            (a) =>
              a.id === id &&
              (!a.archived ||
                (previous && (previous.accountId === id || previous.toAccountId === id))),
          )
        if (
          !allowed(command.data.accountId) ||
          (command.data.kind === 'transfer' && !allowed(command.data.toAccountId))
        )
          throw createError({ statusCode: 400, message: 'Выберите действующий счёт' })
        const data = {
          ...command.data,
          toAccountId: command.data.kind === 'transfer' ? command.data.toAccountId : null,
          importKey: previous?.importKey || null,
          importAccountId:
            previous?.importAccountId || (previous?.importKey ? previous.accountId : null),
        }
        if (command.op === 'transaction.update')
          await db.update(transactions).set(data).where(eq(transactions.id, command.id))
        else await db.insert(transactions).values({ id: crypto.randomUUID(), ...data })
        break
      }
      case 'transaction.delete':
        await db
          .update(transactions)
          .set({ deletedAt: new Date().toISOString() })
          .where(eq(transactions.id, command.id))
        break
      case 'transaction.restore':
        await db
          .update(transactions)
          .set({ deletedAt: null })
          .where(eq(transactions.id, command.id))
        break
      case 'transactions.categorize': {
        const ids = [...new Set(command.ids)]
        const rows = await db.select().from(transactions).where(inArray(transactions.id, ids))
        if (
          rows.length !== ids.length ||
          rows.some((t) => t.deletedAt || !['expense', 'income'].includes(t.kind))
        )
          throw createError({ statusCode: 400, message: 'Выберите действующие расходы или доходы' })
        await db
          .update(transactions)
          .set({ category: command.category })
          .where(inArray(transactions.id, ids))
        break
      }
      case 'goal.create':
        await db.insert(goals).values({ id: crypto.randomUUID(), ...command.data })
        break
      case 'goal.update':
        await db.update(goals).set(command.data).where(eq(goals.id, command.id))
        break
      case 'goal.delete':
        await db.delete(goals).where(eq(goals.id, command.id))
        break
      case 'event.create':
        await db.insert(events).values({ id: crypto.randomUUID(), ...command.data })
        break
      case 'event.toggle':
        await db.update(events).set({ done: command.done }).where(eq(events.id, command.id))
        break
      case 'event.delete':
        await db.delete(events).where(eq(events.id, command.id))
        break
      case 'shopping.create':
        await db.insert(shopping).values({ id: crypto.randomUUID(), ...command.data })
        break
      case 'shopping.toggle':
        await db
          .update(shopping)
          .set({ checked: command.checked })
          .where(eq(shopping.id, command.id))
        break
      case 'shopping.delete':
        await db.delete(shopping).where(eq(shopping.id, command.id))
        break
      case 'shopping.checkout': {
        await db.transaction(async (tx) => {
          const selected = await tx.select().from(shopping).where(eq(shopping.checked, true))
          if (!selected.length)
            throw createError({ statusCode: 400, message: 'Сначала отметьте купленные товары' })
          const [account] = await tx
            .select()
            .from(accounts)
            .where(eq(accounts.id, command.data.accountId))
          if (!account || account.archived)
            throw createError({ statusCode: 400, message: 'Выберите действующий счёт' })
          await tx.insert(transactions).values({
            id: crypto.randomUUID(),
            kind: 'expense',
            amount: command.data.amount,
            accountId: command.data.accountId,
            category: 'Продукты',
            description: selected
              .map((x) => x.title)
              .join(', ')
              .slice(0, 300),
            date: command.data.date,
          })
          await tx.delete(shopping).where(eq(shopping.checked, true))
        })
        break
      }
      case 'obligation.create':
        await db.insert(obligations).values({ id: crypto.randomUUID(), ...command.data })
        break
      case 'obligation.update':
        await db.update(obligations).set(command.data).where(eq(obligations.id, command.id))
        break
      case 'obligation.delete':
        await db.delete(obligations).where(eq(obligations.id, command.id))
        break
      case 'import': {
        let imported = 0
        await db.transaction(async (tx) => {
          const known = (await tx.select().from(accounts)).filter((a) => !a.archived)
          for (const row of command.data.transactions) {
            if (
              !known.some((a) => a.id === row.accountId) ||
              (row.kind === 'transfer' && !known.some((a) => a.id === row.toAccountId))
            )
              throw createError({ statusCode: 400, message: 'Счёт не найден' })
            // Keep equal-looking rows: the importer includes the occurrence number in its key.
            if (!row.importKey)
              throw createError({ statusCode: 400, message: 'Не указан ключ операции импорта' })
            const inserted = await tx
              .insert(transactions)
              .values({
                id: crypto.randomUUID(),
                ...row,
                importAccountId: row.accountId,
                toAccountId: row.kind === 'transfer' ? row.toAccountId : null,
              })
              .onConflictDoNothing()
              .returning()
            imported += inserted.length
          }
        })
        result = { imported, skipped: command.data.transactions.length - imported }
        break
      }
      case 'workspace.restore': {
        if (guard!.revision !== command.expectedRevision)
          throw createError({
            statusCode: 409,
            message: 'Пространство изменилось после предпросмотра. Загрузите копию заново.',
          })
        const backup = command.backup
        await db.delete(paymentOccurrences)
        await db.delete(recurringVersions)
        await db.delete(recurringPayments)
        await db.delete(budgets)
        await db.delete(transactions)
        await db.delete(accounts)
        await db.delete(goals)
        await db.delete(events)
        await db.delete(shopping)
        await db.delete(obligations)
        await db.delete(settings)
        const chunks = <T>(rows: T[]) =>
          Array.from({ length: Math.ceil(rows.length / 500) }, (_, i) =>
            rows.slice(i * 500, (i + 1) * 500),
          )
        for (const rows of chunks(backup.accounts)) await db.insert(accounts).values(rows)
        for (const rows of chunks([...backup.transactions, ...backup.deletedTransactions]))
          await db.insert(transactions).values(rows)
        for (const rows of chunks(backup.goals)) await db.insert(goals).values(rows)
        for (const rows of chunks(backup.events)) await db.insert(events).values(rows)
        for (const rows of chunks(backup.shopping)) await db.insert(shopping).values(rows)
        for (const rows of chunks(backup.obligations)) await db.insert(obligations).values(rows)
        for (const rows of chunks(backup.budgets)) await db.insert(budgets).values(rows)
        for (const rows of chunks(backup.recurringPayments))
          await db.insert(recurringPayments).values(rows)
        for (const rows of chunks(backup.recurringVersions))
          await db.insert(recurringVersions).values(rows)
        for (const rows of chunks(backup.paymentOccurrences))
          await db.insert(paymentOccurrences).values(rows)
        await db.insert(settings).values({ key: 'demo', value: String(backup.isDemo) })
        break
      }
      case 'workspace.reset': {
        await db.transaction(async (tx) => {
          await tx.delete(paymentOccurrences)
          await tx.delete(recurringVersions)
          await tx.delete(recurringPayments)
          await tx.delete(budgets)
          await tx.delete(transactions)
          await tx.delete(accounts)
          await tx.delete(goals)
          await tx.delete(events)
          await tx.delete(shopping)
          await tx.delete(obligations)
          await tx.delete(settings)
        })
        break
      }
    }
    await db
      .update(workspaceGuard)
      .set({ revision: sql`${workspaceGuard.revision} + 1` })
      .where(eq(workspaceGuard.id, 1))
    return result
  })
}

async function seedDemo() {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.select().from(workspaceGuard).where(eq(workspaceGuard.id, 1)).for('update')
    const populated = await Promise.all([
      tx.select().from(accounts),
      tx.select().from(transactions),
      tx.select().from(goals),
      tx.select().from(events),
      tx.select().from(shopping),
      tx.select().from(obligations),
      tx.select().from(budgets),
      tx.select().from(recurringPayments),
    ])
    if (populated.some((rows) => rows.length))
      throw createError({
        statusCode: 409,
        message: 'Демо можно загрузить только в пустое пространство',
      })
    const main = crypto.randomUUID(),
      savings = crypto.randomUUID(),
      cash = crypto.randomUUID()
    await tx.insert(accounts).values([
      { id: main, name: 'Основная карта', kind: 'card', openingBalance: '8640000', color: 'green' },
      {
        id: savings,
        name: 'Накопления',
        kind: 'savings',
        openingBalance: '21000000',
        color: 'blue',
      },
      { id: cash, name: 'Наличные', kind: 'cash', openingBalance: '850000', color: 'sand' },
    ])
    const now = new Date()
    const day = (offset: number) => {
      const date = new Date(now)
      date.setDate(date.getDate() + offset)
      return localDate(date)
    }
    const rows = [
      {
        kind: 'income',
        amount: '18500000',
        category: 'Зарплата',
        description: 'Зарплата',
        date: day(-4),
      },
      {
        kind: 'expense',
        amount: '468000',
        category: 'Продукты',
        description: 'ВкусВилл',
        date: day(0),
      },
      {
        kind: 'expense',
        amount: '42000',
        category: 'Кафе',
        description: 'Кофе и круассан',
        date: day(0),
      },
      {
        kind: 'expense',
        amount: '89000',
        category: 'Транспорт',
        description: 'Яндекс Go',
        date: day(-1),
      },
      {
        kind: 'expense',
        amount: '249000',
        category: 'Покупки',
        description: 'Книга и мелочи для дома',
        date: day(-1),
      },
      {
        kind: 'expense',
        amount: '129900',
        category: 'Подписки',
        description: 'Сервисы и подписки',
        date: day(-2),
      },
      {
        kind: 'expense',
        amount: '724000',
        category: 'Продукты',
        description: 'Покупки на неделю',
        date: day(-2),
      },
      {
        kind: 'expense',
        amount: '350000',
        category: 'Здоровье',
        description: 'Стоматолог',
        date: day(-3),
      },
      {
        kind: 'expense',
        amount: '210000',
        category: 'Развлечения',
        description: 'Кино на двоих',
        date: day(-3),
      },
      {
        kind: 'expense',
        amount: '630000',
        category: 'Дом',
        description: 'Коммунальные услуги',
        date: day(-4),
      },
    ]
    await tx
      .insert(transactions)
      .values(rows.map((row) => ({ id: crypto.randomUUID(), accountId: main, ...row })))
    await tx.insert(goals).values([
      {
        id: crypto.randomUUID(),
        title: 'Отпуск у моря',
        target: '18000000',
        saved: '7200000',
        status: 'saving',
        priority: 'high',
        deadline: day(180),
      },
      {
        id: crypto.randomUUID(),
        title: 'Подушка спокойствия',
        target: '60000000',
        saved: '21000000',
        status: 'saving',
        priority: 'high',
        deadline: null,
      },
      {
        id: crypto.randomUUID(),
        title: 'Новая кофемашина',
        target: '4500000',
        saved: '0',
        status: 'wish',
        priority: 'normal',
        deadline: null,
      },
      {
        id: crypto.randomUUID(),
        title: 'Рабочее кресло',
        target: '3200000',
        saved: '3200000',
        status: 'planned',
        priority: 'normal',
        deadline: day(15),
      },
    ])
    await tx.insert(events).values([
      {
        id: crypto.randomUUID(),
        title: 'Платёж по ипотеке',
        date: day(3),
        kind: 'payment',
        amount: '4250000',
        done: false,
        note: 'Проверьте остаток на счёте накануне платежа',
      },
      {
        id: crypto.randomUUID(),
        title: 'Запланировать выходные',
        date: day(1),
        kind: 'task',
        amount: null,
        done: false,
        note: '',
      },
      {
        id: crypto.randomUUID(),
        title: 'Проверить тариф связи',
        date: day(5),
        kind: 'task',
        amount: null,
        done: false,
        note: '',
      },
      {
        id: crypto.randomUUID(),
        title: 'Разобрать бюджет месяца',
        date: day(7),
        kind: 'task',
        amount: null,
        done: false,
        note: 'Проверить категории и планы',
      },
    ])
    await tx.insert(shopping).values([
      { id: crypto.randomUUID(), title: 'Молоко', quantity: '2 л', price: '24000', checked: false },
      {
        id: crypto.randomUUID(),
        title: 'Авокадо',
        quantity: '2 шт.',
        price: '32000',
        checked: false,
      },
      {
        id: crypto.randomUUID(),
        title: 'Хлеб на закваске',
        quantity: '1 шт.',
        price: '18000',
        checked: true,
      },
      {
        id: crypto.randomUUID(),
        title: 'Яйца',
        quantity: '10 шт.',
        price: '16000',
        checked: false,
      },
    ])
    await tx.insert(obligations).values([
      {
        id: crypto.randomUUID(),
        title: 'Ипотека · наша квартира',
        kind: 'mortgage',
        remaining: '485000000',
        payment: '4250000',
        dueDay: 8,
        rate: '8.5',
      },
      {
        id: crypto.randomUUID(),
        title: 'Кредит на автомобиль',
        kind: 'credit',
        remaining: '38000000',
        payment: '1870000',
        dueDay: 20,
        rate: '14.9',
      },
    ])
    await tx.insert(budgets).values(
      [
        ['Продукты', '3000000'],
        ['Дом', '1200000'],
        ['Транспорт', '1000000'],
        ['Покупки', '200000'],
      ].map(([category, limit]) => ({
        id: crypto.randomUUID(),
        month: day(0).slice(0, 7),
        category: category!,
        limit: limit!,
      })),
    )
    await executePlanningCommand(
      tx,
      {
        op: 'recurring.save',
        data: {
          title: 'Интернет и связь',
          category: 'Дом',
          amount: '150000',
          accountId: main,
          frequency: 'monthly',
          interval: 1,
          startDate: day(5),
          endDate: null,
          note: 'Проверить сумму в личном кабинете перед оплатой',
        },
      },
      '0',
    )
    await tx
      .insert(settings)
      .values({ key: 'demo', value: 'true' })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'true' } })
    await tx
      .update(workspaceGuard)
      .set({ revision: sql`${workspaceGuard.revision} + 1` })
      .where(eq(workspaceGuard.id, 1))
  })
}
