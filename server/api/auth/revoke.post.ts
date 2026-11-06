import { z } from 'zod'
import { revokeSession, requireActor, clearSessionCookie } from '../../modules/auth'
import { readValidatedJSON } from '../../utils/read-json'
export default defineEventHandler(async (event) => {
  const { id } = await readValidatedJSON(event, z.object({ id: z.uuid() }), 1024),
    actor = requireActor(event)
  await revokeSession(actor, id)
  if (id === actor.sessionId) clearSessionCookie(event)
  return { ok: true }
})
