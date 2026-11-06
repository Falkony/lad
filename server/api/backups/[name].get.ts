import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getWorkspaceBackups } from '../../modules/workspace'

export default defineEventHandler(async (event) => {
  const backups = getWorkspaceBackups()
  await backups.start()
  const name = getRouterParam(event, 'name') || ''
  try {
    const backup = await backups.read(name)
    setHeader(event, 'Content-Disposition', `attachment; filename="${name}"`)
    return backup
  } catch {
    throw createError({ statusCode: 404, message: 'Копия недоступна или не прошла проверку' })
  }
})
