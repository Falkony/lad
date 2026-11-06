import { createError, defineEventHandler, getQuery } from 'h3'
import { z } from 'zod'
import { readCommandHistory } from '../modules/command-history'
import { revision } from '../../shared/schemas'

const querySchema = z.object({
  before: revision.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export default defineEventHandler(async (event) => {
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success)
    throw createError({ statusCode: 400, message: 'Некорректные параметры истории' })
  return readCommandHistory(parsed.data.before, parsed.data.limit)
})
