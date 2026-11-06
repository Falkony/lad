import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { createError } from 'h3'
import type { WriteTransaction } from '../db'
import {
  categories,
  transactions,
  budgets,
  plans,
  planVersions,
  planOccurrences,
  settings,
  goals,
} from '../db/schema'
import { revision } from '../../shared/schemas'
import { validTimeZone } from '../../shared/time-zone'
const name = z.string().trim().min(1).max(160)
export const categoryCommands = [
  z.object({ op: z.literal('category.create'), name }),
  z.object({ op: z.literal('category.rename'), id: z.uuid(), name, expectedRevision: revision }),
  z.object({ op: z.literal('category.archive'), id: z.uuid(), archived: z.boolean() }),
  z.object({
    op: z.literal('category.merge'),
    id: z.uuid(),
    targetId: z.uuid(),
    expectedRevision: revision,
  }),
  z.object({
    op: z.literal('settings.update'),
    timeZone: z.string().refine(validTimeZone, 'Неизвестный часовой пояс'),
    expectedRevision: revision,
  }),
] as const
const schema = z.discriminatedUnion('op', categoryCommands)
export type CategoryCommand = z.infer<typeof schema>
export function isCategoryCommand(command: { op: string }): command is CategoryCommand {
  return command.op.startsWith('category.') || command.op === 'settings.update'
}
export async function executeCategoryCommand(db: WriteTransaction, command: CategoryCommand) {
  if (command.op === 'settings.update') {
    await db
      .insert(settings)
      .values({ key: 'time_zone', value: command.timeZone })
      .onConflictDoUpdate({ target: settings.key, set: { value: command.timeZone } })
    return { ok: true }
  }
  if (command.op === 'category.create') {
    await db.insert(categories).values({ id: crypto.randomUUID(), name: command.name })
    return { ok: true }
  }
  const [source] = await db.select().from(categories).where(eq(categories.id, command.id))
  if (!source) throw createError({ statusCode: 404, message: 'Категория не найдена' })
  if (command.op === 'category.archive') {
    await db
      .update(categories)
      .set({ archived: command.archived })
      .where(eq(categories.id, source.id))
    return { ok: true }
  }
  const target =
    command.op === 'category.rename'
      ? { id: source.id, name: command.name }
      : (await db.select().from(categories).where(eq(categories.id, command.targetId)))[0]
  if (!target || (target.id === source.id && command.op === 'category.merge'))
    throw createError({ statusCode: 400, message: 'Выберите другую категорию' })
  if (command.op === 'category.rename')
    await db.update(categories).set({ name: target.name }).where(eq(categories.id, source.id))
  else {
    for (const budget of await db.select().from(budgets).where(eq(budgets.categoryId, source.id))) {
      const [other] = await db
        .select()
        .from(budgets)
        .where(and(eq(budgets.categoryId, target.id), eq(budgets.month, budget.month)))
      if (other) {
        await db
          .update(budgets)
          .set({ limit: (BigInt(other.limit) + BigInt(budget.limit)).toString() })
          .where(eq(budgets.id, other.id))
        await db.delete(budgets).where(eq(budgets.id, budget.id))
      } else
        await db
          .update(budgets)
          .set({ categoryId: target.id, category: target.name })
          .where(eq(budgets.id, budget.id))
    }
  }
  for (const table of [transactions, plans, planVersions, planOccurrences])
    await db
      .update(table)
      .set({ categoryId: target.id, category: target.name })
      .where(eq(table.categoryId, source.id))
  if (command.op === 'category.rename')
    await db.update(budgets).set({ category: target.name }).where(eq(budgets.categoryId, source.id))
  else {
    await db.update(goals).set({ categoryId: target.id }).where(eq(goals.categoryId, source.id))
    await db.delete(categories).where(eq(categories.id, source.id))
  }
  return { ok: true }
}

export async function checkCategoryInput(
  db: WriteTransaction,
  command: { op: string; [key: string]: any },
) {
  const values: string[] =
    command.op === 'import'
      ? command.data.transactions.map((row: any) => row.category)
      : ['transaction.create', 'transaction.update', 'plan.save', 'budget.set'].includes(command.op)
        ? [command.data.category]
        : command.op === 'transactions.categorize'
          ? [command.category]
          : []
  for (const value of new Set(values)) {
    const [category] = await db.select().from(categories).where(eq(categories.name, value))
    if (!category?.archived) continue
    const table =
      command.op === 'transaction.update'
        ? transactions
        : command.op === 'plan.save' && command.id
          ? plans
          : null
    if (table) {
      const [row] = await db.select().from(table).where(eq(table.id, command.id))
      if (row?.categoryId === category.id) continue
    }
    if (
      command.op === 'budget.set' &&
      (
        await db
          .select()
          .from(budgets)
          .where(and(eq(budgets.month, command.data.month), eq(budgets.categoryId, category.id)))
      ).length
    )
      continue
    throw createError({
      statusCode: 400,
      message: 'Категория в архиве. Выберите действующую категорию.',
    })
  }
}
