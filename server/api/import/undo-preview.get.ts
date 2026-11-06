import { z } from 'zod'
import { previewImportUndo } from '../../modules/import-workflow'
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return previewImportUndo(z.uuid().parse(getQuery(event).id))
})
