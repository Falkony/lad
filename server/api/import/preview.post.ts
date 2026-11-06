import { importSchema } from '../../../shared/schemas'
import { previewStatement } from '../../modules/import-workflow'
import { getDb } from '../../db'
import { readJSON } from '../../utils/read-json'
export default defineEventHandler(async (event) => {
  await getDb()
  setHeader(event, 'Cache-Control', 'no-store')
  return previewStatement(importSchema.parse(await readJSON(event)))
})
