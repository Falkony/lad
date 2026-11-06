import { readWorkspace } from '../modules/workspace'
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return readWorkspace()
})
