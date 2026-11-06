import { z } from 'zod'
import { readImportBatches } from '../../modules/import-workflow'
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return readImportBatches(
    z.coerce.number().int().min(1).max(100000).default(1).parse(getQuery(event).page),
  )
})
