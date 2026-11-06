import { z } from 'zod'
import { changePassword, requireActor, writeSessionCookie } from '../../modules/auth'
import { readValidatedJSON } from '../../utils/read-json'
export default defineEventHandler(async (event) => {
  const input = await readValidatedJSON(
    event,
    z.object({ currentPassword: z.string().max(256), newPassword: z.string().min(12).max(256) }),
    4096,
  )
  const session = await changePassword(
    requireActor(event),
    input.currentPassword,
    input.newPassword,
  )
  writeSessionCookie(event, session.token)
  return { ok: true }
})
