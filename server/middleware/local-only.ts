import { defineEventHandler, getHeader, createError, setHeader } from 'h3'

export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/')) return
  // Nitro's dev worker omits socket metadata. Both supported launchers bind to
  // loopback; when the native address exists, also reject non-local peers.
  const address = event.node.req.socket?.remoteAddress
  if (address && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address))
    throw createError({ statusCode: 403, message: 'Эта версия работает только локально' })
  const host = getHeader(event, 'host') || ''
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname))
    throw createError({ statusCode: 403, message: 'Эта версия работает только локально' })
  const origin = getHeader(event, 'origin')
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      /* invalid origin */
    }
    if (originHost !== host)
      throw createError({ statusCode: 403, message: 'Недопустимый источник запроса' })
  }
  setHeader(event, 'Cache-Control', 'no-store')
})
