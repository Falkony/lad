import { defineEventHandler, setHeader } from 'h3'
import { enforceApiAccess, apiPath, isApiPath } from '../modules/auth'
export default defineEventHandler(async (event) => {
  if (!isApiPath(apiPath(event))) return
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Cross-Origin-Resource-Policy', 'same-origin')
  await enforceApiAccess(event)
})
