import { readWorkspace } from '../modules/workspace'
import { createBackup } from '../../shared/backup'
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return createBackup(await readWorkspace(true))
})
