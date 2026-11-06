import { defineEventHandler } from 'h3'
import { getWorkspaceBackups } from '../../modules/workspace'

export default defineEventHandler(async () => {
  const backups = getWorkspaceBackups()
  await backups.start()
  return backups.status()
})
