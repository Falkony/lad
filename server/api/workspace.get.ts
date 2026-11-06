import { readWorkspace } from '../modules/workspace'
import { z } from 'zod'
import { localDate } from '../../shared/money'
import { addDays } from '../../shared/planning'
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const from = z.iso.date().parse(getQuery(event).from || addDays(localDate(), -100))
  return readWorkspace(false, from)
})
