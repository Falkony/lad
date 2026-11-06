import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { createError } from 'h3'
import { getDb, type WriteTransaction } from '../db'
import {
  accounts,
  transactions,
  categories,
  importRules,
  importTemplates,
  importBatches,
  importKeys,
  plans,
  planVersions,
  planOccurrences,
  obligationEntries,
  goals,
  workspaceGuard,
} from '../db/schema'
import { importSchema, revision } from '../../shared/schemas'
import {
  importRuleSchema,
  importMappingSchema,
  type ImportBatch,
  type ImportSuggestion,
} from '../../shared/import-workflow'
import { projectPlans, addDays } from '../../shared/planning'
import { executePlanningCommand } from './planning'
import { afterPlanConfirm } from './obligations'
import { afterGoalConfirm } from './goals'
import type { Plan, PlanVersion, PlanOccurrence } from '../../shared/planning-types'
import type { Transaction } from '../../shared/types'
import { fundingOf } from '../../shared/goals'
const fail = (message: string) => createError({ statusCode: 409, message })
export const importCommands = [
  z.object({
    op: z.literal('import.rule.save'),
    id: z.uuid().optional(),
    data: importRuleSchema,
    expectedRevision: revision.optional(),
  }),
  z.object({ op: z.literal('import.rule.delete'), id: z.uuid() }),
  z.object({
    op: z.literal('import.template.save'),
    name: z.string().trim().min(1).max(160),
    mapping: importMappingSchema,
  }),
  z.object({ op: z.literal('import.template.delete'), id: z.uuid() }),
  z.object({ op: z.literal('import.undo'), id: z.uuid(), expectedRevision: revision }),
] as const
type WorkflowCommand = z.infer<(typeof importCommands)[number]>
export const isImportWorkflowCommand = (c: { op: string }): c is WorkflowCommand =>
  c.op.startsWith('import.')
async function prepared(db: WriteTransaction, data: z.infer<typeof importSchema>) {
  const rules = await db.select().from(importRules),
    catalogue = await db.select().from(categories)
  return data.transactions.map((row) => {
    const rule = rules
      .filter(
        (r) =>
          r.enabled &&
          (!r.accountId || r.accountId === row.accountId) &&
          (!r.kind || r.kind === row.kind) &&
          row.description.toLocaleLowerCase('ru').includes(r.pattern.toLocaleLowerCase('ru')),
      )
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .find((r) => catalogue.some((c) => c.id === r.categoryId && !c.archived))
    return {
      ...row,
      category: rule ? catalogue.find((c) => c.id === rule.categoryId)!.name : row.category,
    }
  })
}
export async function previewStatement(data: z.infer<typeof importSchema>) {
  const client = await getDb()
  return client.transaction(
    async (db) => {
      const rows = await prepared(db, data),
        history = await db.select().from(transactions),
        keys = await db.select().from(importKeys),
        p = await db.select().from(plans),
        v = await db.select().from(planVersions),
        o = await db.select().from(planOccurrences)
      const dates = rows.map((r) => r.date).sort(),
        projected = projectPlans(
          {
            plans: p as Plan[],
            planVersions: v as PlanVersion[],
            planOccurrences: o as PlanOccurrence[],
            transactions: history.filter((t) => !t.deletedAt) as Transaction[],
            deletedTransactions: history.filter((t) => !!t.deletedAt) as Transaction[],
          },
          addDays(dates[0]!, -3),
          addDays(dates.at(-1)!, 3),
        )
      const suggestions: ImportSuggestion[] = rows.map((row, index) => {
        const manual = history.filter(
            (t) =>
              !t.deletedAt &&
              !t.importKey &&
              t.accountId === row.accountId &&
              t.kind === row.kind &&
              t.amount === row.amount &&
              t.date === row.date,
          ),
          transfers = history.filter(
            (t) =>
              !t.deletedAt &&
              t.kind === 'transfer' &&
              t.amount === row.amount &&
              t.date === row.date &&
              (t.accountId === row.accountId || t.toAccountId === row.accountId),
          ),
          matches = projected.filter(
            (p) =>
              p.status === 'pending' &&
              p.amount === row.amount &&
              p.direction === row.kind &&
              (!p.accountId || p.accountId === row.accountId) &&
              p.date >= addDays(row.date, -3) &&
              p.date <= addDays(row.date, 3),
          )
        return {
          index,
          duplicate: keys.some((k) => k.accountId === row.accountId && k.key === row.importKey),
          manualIds: manual.map((t) => t.id),
          transferIds: transfers.map((t) => t.id),
          plans: matches.map((p) => ({ planId: p.planId, dueDate: p.dueDate, title: p.title })),
          ambiguous: manual.length + transfers.length + matches.length > 1,
        }
      })
      const candidateIds = new Set(suggestions.flatMap((s) => [...s.manualIds, ...s.transferIds]))
      const labels = Object.fromEntries(
        history
          .filter((t) => candidateIds.has(t.id))
          .map((t) => [t.id, `${t.date} · ${t.description || t.category} · ${t.amount}`]),
      )
      const [guard] = await db.select().from(workspaceGuard)
      return { rows, suggestions, labels, revision: guard!.revision }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
const snapshot = (row: Record<string, unknown>) =>
  JSON.parse(
    JSON.stringify(
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'workspaceId')),
    ),
  ) as Record<string, unknown>
const canonical = (row: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
export async function applyStatement(
  db: WriteTransaction,
  data: z.infer<typeof importSchema>,
  currentRevision: string,
) {
  const rows = await prepared(db, data),
    known = await db.select().from(accounts),
    id = crypto.randomUUID(),
    report = { imported: 0, skipped: 0, matched: 0, linked: 0, ignored: 0 },
    records: ImportBatch['records'] = [],
    seen = new Set<number>()
  for (const decision of data.decisions) {
    if (seen.has(decision.index) || decision.index >= rows.length)
      throw fail('Повтор или неверный номер решения импорта')
    seen.add(decision.index)
  }
  await db.insert(importBatches).values({
    id,
    createdAt: new Date().toISOString(),
    fileName: data.fileName,
    status: 'applied',
    revision: (BigInt(currentRevision) + 1n).toString(),
    report,
    records,
  })
  for (const [index, row] of rows.entries()) {
    if (!row.importKey) throw fail('Не указан ключ операции импорта')
    const existing = await db
      .select()
      .from(importKeys)
      .where(and(eq(importKeys.accountId, row.accountId), eq(importKeys.key, row.importKey)))
    if (existing.length) {
      report.skipped++
      continue
    }
    const decision = data.decisions.find((d) => d.index === index) || {
      index,
      action: 'new' as const,
    }
    if (decision.action === 'ignore') {
      report.ignored++
      continue
    }
    if (!known.some((a) => a.id === row.accountId && !a.archived)) throw fail('Счёт не найден')
    let transactionId: string,
      created = false
    if (decision.action === 'match') {
      const [t] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, decision.transactionId || ''))
      if (
        !t ||
        t.deletedAt ||
        t.amount !== row.amount ||
        t.date !== row.date ||
        (t.kind !== 'transfer' && (t.kind !== row.kind || t.accountId !== row.accountId)) ||
        (t.kind === 'transfer' &&
          ((row.kind === 'expense' && t.accountId !== row.accountId) ||
            (row.kind === 'income' && t.toAccountId !== row.accountId)))
      )
        throw fail('Совпадение изменилось: обновите предпросмотр')
      transactionId = t.id
      report.matched++
    } else {
      if (decision.action === 'transfer' && !decision.toAccountId)
        throw fail('Выберите второй собственный счёт')
      const [selectedPlan] =
        decision.action === 'plan'
          ? await db
              .select()
              .from(plans)
              .where(eq(plans.id, decision.planId || ''))
          : []
      const creditTarget = selectedPlan?.source === 'credit' ? selectedPlan.sourceId : null
      const target =
        creditTarget ||
        (decision.action === 'transfer'
          ? row.kind === 'income'
            ? row.accountId
            : decision.toAccountId
          : row.toAccountId)
      const source =
        decision.action === 'transfer' && row.kind === 'income'
          ? decision.toAccountId!
          : row.accountId
      if (
        (decision.action === 'transfer' || row.kind === 'transfer') &&
        (!target ||
          source === target ||
          !known.some((a) => a.id === target && !a.archived) ||
          !known.some((a) => a.id === source && !a.archived))
      )
        throw fail('Выберите два действующих счёта для перевода')
      transactionId = crypto.randomUUID()
      const inserted = await db
        .insert(transactions)
        .values({
          ...row,
          id: transactionId,
          kind: creditTarget || decision.action === 'transfer' ? 'transfer' : row.kind,
          accountId: source,
          toAccountId: target,
          importAccountId: row.accountId,
        })
        .onConflictDoNothing()
        .returning()
      if (!inserted.length) {
        report.skipped++
        continue
      }
      created = true
      report.imported++
      if (decision.action === 'plan') {
        if (!decision.planId || !decision.dueDate) throw fail('Выберите дату плана')
        const result = await executePlanningCommand(
          db,
          {
            op: 'occurrence.confirm',
            planId: decision.planId,
            dueDate: decision.dueDate,
            date: row.date,
            mode: 'link',
            transactionId,
            expectedRevision: currentRevision,
          },
          currentRevision,
        )
        if (result.alreadyPaid) throw fail('Дата плана уже подтверждена другой операцией')
        await afterPlanConfirm(db, decision.planId, transactionId)
        await afterGoalConfirm(db, decision.planId, transactionId)
        report.linked++
      }
    }
    await db.insert(importKeys).values({
      id: crypto.randomUUID(),
      accountId: row.accountId,
      key: row.importKey,
      transactionId,
      batchId: id,
    })
    const [t] = await db.select().from(transactions).where(eq(transactions.id, transactionId))
    records.push({
      id: transactionId,
      accountId: row.accountId,
      key: row.importKey,
      created,
      snapshot: snapshot(t!),
    })
  }
  await db.update(importBatches).set({ report, records }).where(eq(importBatches.id, id))
  return { ...report, batchId: id }
}
async function undoPreview(db: WriteTransaction, id: string) {
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, id))
  if (!batch) throw createError({ statusCode: 404, message: 'Пакет не найден' })
  const problems: string[] = []
  if (batch.status === 'undone') problems.push('Пакет уже отменён')
  const history = await db.select().from(transactions),
    occurrences = await db.select().from(planOccurrences),
    entries = await db.select().from(obligationEntries),
    goalRows = await db.select().from(goals)
  const aliases = await db.select().from(importKeys)
  for (const record of batch.records.filter((r) => r.created)) {
    const t = history.find((t) => t.id === record.id),
      label = `${t?.date || record.snapshot.date} · ${t?.description || record.snapshot.description || 'Операция'}`
    if (!t || canonical(snapshot(t)) !== canonical(record.snapshot))
      problems.push(`${label}: операция изменена после импорта`)
    if (
      occurrences.some((o) => o.transactionId === record.id) ||
      entries.some((e) => e.transactionId === record.id) ||
      goalRows.some((g) =>
        fundingOf(g).purchases.some(
          (p) => p.transactionId === record.id || p.refundIds.includes(record.id),
        ),
      ) ||
      history.some((t) => t.refundOf === record.id) ||
      aliases.some((a) => a.transactionId === record.id && a.batchId !== id)
    )
      problems.push(
        `${label}: операция связана с планом, покупкой, погашением, возвратом или другим пакетом`,
      )
  }
  return {
    batch,
    problems,
    created: batch.records.filter((r) => r.created).length,
    matched: batch.records.filter((r) => !r.created).length,
  }
}
export async function previewImportUndo(id: string) {
  const db = await getDb()
  return db.transaction(
    async (tx) => {
      const preview = await undoPreview(tx, id)
      const [guard] = await tx.select().from(workspaceGuard)
      return { ...preview, revision: guard!.revision }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export async function readImportBatches(page = 1) {
  const db = await getDb()
  return db
    .select({
      id: importBatches.id,
      createdAt: importBatches.createdAt,
      fileName: importBatches.fileName,
      status: importBatches.status,
      revision: importBatches.revision,
      report: importBatches.report,
    })
    .from(importBatches)
    .orderBy(desc(importBatches.createdAt), desc(importBatches.id))
    .limit(20)
    .offset((page - 1) * 20)
}
export async function executeImportWorkflow(db: WriteTransaction, c: WorkflowCommand) {
  if (c.op === 'import.rule.save') {
    const [category] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, c.data.categoryId))
    if (!category || category.archived) throw fail('Выберите действующую категорию')
    if (c.id) await db.update(importRules).set(c.data).where(eq(importRules.id, c.id))
    else await db.insert(importRules).values({ id: crypto.randomUUID(), ...c.data })
  } else if (c.op === 'import.rule.delete')
    await db.delete(importRules).where(eq(importRules.id, c.id))
  else if (c.op === 'import.template.save')
    await db
      .insert(importTemplates)
      .values({ id: crypto.randomUUID(), name: c.name, mapping: c.mapping })
      .onConflictDoUpdate({ target: importTemplates.name, set: { mapping: c.mapping } })
  else if (c.op === 'import.template.delete')
    await db.delete(importTemplates).where(eq(importTemplates.id, c.id))
  else {
    const preview = await undoPreview(db, c.id)
    if (preview.problems.length) throw fail(preview.problems.join('; '))
    for (const record of preview.batch.records.filter((r) => r.created))
      await db
        .update(transactions)
        .set({ deletedAt: new Date().toISOString(), importKey: null, importAccountId: null })
        .where(eq(transactions.id, record.id))
    await db.delete(importKeys).where(eq(importKeys.batchId, c.id))
    await db.update(importBatches).set({ status: 'undone' }).where(eq(importBatches.id, c.id))
  }
  return { ok: true }
}
