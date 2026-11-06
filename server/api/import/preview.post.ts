import { importSchema } from '../../../shared/schemas'
import { previewStatement } from '../../modules/import-workflow'
import { getDb } from '../../db'
export default defineEventHandler(async (event) => {
  await getDb()
  setHeader(event, 'Cache-Control', 'no-store')
  return previewStatement(importSchema.parse(await readBody(event)))
})
