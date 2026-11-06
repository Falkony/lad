import { and, eq, desc, sql, or, inArray, isNull, isNotNull } from 'drizzle-orm'
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
  plans,
  planVersions,
  planOccurrences,
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
  pastDate,
  revision,
} from '../../shared/schemas'
import { localDate, accountBalance } from '../../shared/money'
import { backupSchema } from '../../shared/backup'
import type { Account, Transaction } from '../../shared/types'
import type { Workspace } from '../../shared/types'
import type { CommandResult } from '../../shared/planning-types'
import { planningCommands, isPlanningCommand, executePlanningCommand } from './planning'

/** Throws 404 when an update/delete touched nothing, so a stale UI does not report success. */
export function found<T>(rows: T[], message: string): T[] {
  if (!rows.length) throw createError({ statusCode: 404, message })
  return rows
}

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
        db.select().from(plans).orderBy(plans.title),
        db.select().from(planVersions),
        db.select().from(planOccurrences),
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
        plans: r,
        planVersions: v,
        planOccurrences: p,
      } as Workspace
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

export const commandSchema = z.discriminatedUnion('op', [
  ...planningCommands,
  z.object({ op: z.literal('account.create'), data: accountSchema }),
  z.object({
    op: z.literal('account.update'),
    id: z.uuid(),
    data: accountSchema,
    expectedRevision: revision.optional(),
  }),
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
  z.object({
    op: z.literal('transaction.update'),
    id: z.uuid(),
    data: transactionSchema,
    expectedRevision: revision.optional(),
  }),
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
    expectedRevision: revision,
    confirmation: z.literal('ВОССТАНОВИТЬ'),
  }),
  z.object({ op: z.literal('goal.create'), data: goalSchema }),
  z.object({
    op: z.literal('goal.update'),
    id: z.uuid(),
    data: goalSchema,
    expectedRevision: revision.optional(),
  }),
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
      date: pastDate('Дата покупки не может быть в будущем'),
    }),
  }),
  z.object({ op: z.literal('obligation.create'), data: obligationSchema }),
  z.object({
    op: z.literal('obligation.update'),
    id: z.uuid(),
    data: obligationSchema,
    expectedRevision: revision.optional(),
  }),
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
    // Full-object edits overwrite every field: reject forms opened before another change.
    if (
      'expectedRevision' in command &&
      command.expectedRevision !== undefined &&
      command.op !== 'workspace.restore' &&
      command.expectedRevision !== guard!.revision
    )
      throw createError({
        statusCode: 409,
        message: 'Данные изменились в другой вкладке. Проверьте их и сохраните ещё раз.',
      })
    let result: CommandResult = { ok: true }
    switch (command.op) {
      case 'account.create':
        await db.insert(accounts).values({
          id: crypto.randomUUID(),
          ...command.data,
          inForecast: command.data.inForecast ?? command.data.kind !== 'savings',
        })
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
          db.select().from(plans).where(eq(plans.accountId, command.id)).limit(1),
          db.select().from(planVersions).where(eq(planVersions.accountId, command.id)).limit(1),
          db
            .select()
            .from(planOccurrences)
            .where(eq(planOccurrences.accountId, command.id))
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
        if (previous) {
          // A transaction confirming a plan keeps the plan's direction: an expense for a
          // payment, an income for an expected income.
          const [link] = await db
            .select({ direction: plans.direction })
            .from(planOccurrences)
            .innerJoin(plans, eq(plans.id, planOccurrences.planId))
            .where(eq(planOccurrences.transactionId, previous.id))
            .limit(1)
          if (link && command.data.kind !== link.direction)
            throw createError({
              statusCode: 409,
              message: `Операция подтверждает план и должна оставаться ${
                link.direction === 'income' ? 'доходом' : 'расходом'
              }`,
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
        found(
          await db
            .update(transactions)
            .set({ deletedAt: new Date().toISOString() })
            .where(and(eq(transactions.id, command.id), isNull(transactions.deletedAt)))
            .returning(),
          'Операция не найдена',
        )
        break
      case 'transaction.restore':
        found(
          await db
            .update(transactions)
            .set({ deletedAt: null })
            .where(and(eq(transactions.id, command.id), isNotNull(transactions.deletedAt)))
            .returning(),
          'Удалённая операция не найдена',
        )
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
        found(
          await db.update(goals).set(command.data).where(eq(goals.id, command.id)).returning(),
          'Цель не найдена',
        )
        break
      case 'goal.delete':
        found(await db.delete(goals).where(eq(goals.id, command.id)).returning(), 'Цель не найдена')
        break
      case 'event.create':
        await db.insert(events).values({ id: crypto.randomUUID(), ...command.data })
        break
      case 'event.toggle':
        found(
          await db
            .update(events)
            .set({ done: command.done })
            .where(eq(events.id, command.id))
            .returning(),
          'Событие не найдено',
        )
        break
      case 'event.delete':
        found(
          await db.delete(events).where(eq(events.id, command.id)).returning(),
          'Событие не найдено',
        )
        break
      case 'shopping.create':
        await db.insert(shopping).values({ id: crypto.randomUUID(), ...command.data })
        break
      case 'shopping.toggle':
        found(
          await db
            .update(shopping)
            .set({ checked: command.checked })
            .where(eq(shopping.id, command.id))
            .returning(),
          'Товар не найден',
        )
        break
      case 'shopping.delete':
        found(
          await db.delete(shopping).where(eq(shopping.id, command.id)).returning(),
          'Товар не найден',
        )
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
        found(
          await db
            .update(obligations)
            .set(command.data)
            .where(eq(obligations.id, command.id))
            .returning(),
          'Обязательство не найдено',
        )
        break
      case 'obligation.delete':
        found(
          await db.delete(obligations).where(eq(obligations.id, command.id)).returning(),
          'Обязательство не найдено',
        )
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
        await db.delete(planOccurrences)
        await db.delete(planVersions)
        await db.delete(plans)
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
        for (const rows of chunks(backup.plans)) await db.insert(plans).values(rows)
        for (const rows of chunks(backup.planVersions)) await db.insert(planVersions).values(rows)
        for (const rows of chunks(backup.planOccurrences))
          await db.insert(planOccurrences).values(rows)
        await db.insert(settings).values({ key: 'demo', value: String(backup.isDemo) })
        break
      }
      case 'workspace.reset': {
        await db.transaction(async (tx) => {
          await tx.delete(planOccurrences)
          await tx.delete(planVersions)
          await tx.delete(plans)
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
      tx.select().from(plans),
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
        inForecast: false,
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
    const demoPlans = [
      {
        direction: 'expense' as const,
        title: 'Интернет и связь',
        category: 'Дом',
        amount: '150000',
        accountId: main,
        frequency: 'monthly' as const,
        startDate: day(5),
        note: 'Проверить сумму в личном кабинете перед оплатой',
      },
      {
        direction: 'expense' as const,
        title: 'Платёж по ипотеке',
        category: 'Дом',
        amount: '4250000',
        accountId: main,
        frequency: 'once' as const,
        startDate: day(3),
        note: 'Проверьте остаток на счёте накануне платежа',
      },
      {
        direction: 'income' as const,
        title: 'Зарплата',
        category: 'Зарплата',
        amount: '18500000',
        accountId: main,
        frequency: 'monthly' as const,
        startDate: day(26),
        note: '',
      },
    ]
    for (const { direction, ...plan } of demoPlans)
      await executePlanningCommand(
        tx,
        {
          op: 'plan.save',
          direction,
          data: { ...plan, interval: 1, endDate: null },
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
