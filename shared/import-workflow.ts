import { z } from 'zod'
export const importMappingSchema = z.object({
  date: z.string().max(160),
  amount: z.string().max(160),
  description: z.string().max(160),
  category: z.string().max(160),
  externalId: z.string().max(160),
  mode: z.enum(['signed', 'expense', 'income']),
})
export const importRuleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  pattern: z.string().trim().min(1).max(160),
  accountId: z.uuid().nullable().default(null),
  kind: z.enum(['income', 'expense']).nullable().default(null),
  categoryId: z.uuid(),
  priority: z.number().int().min(0).max(999).default(100),
  enabled: z.boolean().default(true),
})
export const importDecisionSchema = z.object({
  index: z.number().int().min(0).max(1999),
  action: z.enum(['new', 'ignore', 'match', 'plan', 'transfer']),
  transactionId: z.uuid().optional(),
  planId: z.uuid().optional(),
  dueDate: z.iso.date().optional(),
  toAccountId: z.uuid().optional(),
})
export type ImportDecision = z.infer<typeof importDecisionSchema>
export interface ImportBatch {
  id: string
  createdAt: string
  fileName: string
  status: 'applied' | 'undone'
  revision: string
  report: { imported: number; skipped: number; matched: number; linked: number; ignored: number }
  records: {
    id: string
    accountId: string
    key: string
    created: boolean
    snapshot: Record<string, unknown>
  }[]
}
export type ImportRule = z.infer<typeof importRuleSchema> & { id: string }
export interface ImportTemplate {
  id: string
  name: string
  mapping: z.infer<typeof importMappingSchema>
}
export interface ImportKey {
  id: string
  accountId: string
  key: string
  transactionId: string
  batchId: string | null
}
export interface ImportSuggestion {
  index: number
  duplicate: boolean
  manualIds: string[]
  transferIds: string[]
  plans: { planId: string; dueDate: string; title: string }[]
  ambiguous: boolean
}
