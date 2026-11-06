import { z } from 'zod'
export const categorySchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(160),
  archived: z.boolean().default(false),
})
export type Category = z.infer<typeof categorySchema>
const sections = [
  'transactions',
  'deletedTransactions',
  'budgets',
  'plans',
  'planVersions',
  'planOccurrences',
] as const
/** Upgrade portable files once; preserve IDs in files already using the catalogue. */
export function withCategoryIds(input: Record<string, any>) {
  const catalogue: Category[] = Array.isArray(input.categories) ? [...input.categories] : []
  const byName = new Map(catalogue.map((c) => [c.name, c]))
  const output: Record<string, any> = { ...input, categories: catalogue }
  for (const section of sections)
    output[section] = (input[section] || []).map((row: any) => {
      let category = row.categoryId
        ? catalogue.find((c) => c.id === row.categoryId)
        : byName.get(row.category)
      if (!category) {
        category = { id: crypto.randomUUID(), name: row.category, archived: false }
        catalogue.push(category!)
        byName.set(row.category, category!)
      }
      return { ...row, categoryId: category!.id }
    })
  return output
}
