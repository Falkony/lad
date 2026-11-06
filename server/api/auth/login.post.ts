import { getCookie } from 'h3'
import { loginSchema, login, sessionCookieName, writeSessionCookie } from '../../modules/auth'
import { readValidatedJSON } from '../../utils/read-json'
export default defineEventHandler(async (event) => {
  const input = await readValidatedJSON(event, loginSchema, 4096),
    session = await login(
      input,
      event.node.req.socket?.remoteAddress || 'dev',
      getCookie(event, sessionCookieName()),
    )
  writeSessionCookie(event, session.token)
  return { ok: true }
})
