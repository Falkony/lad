import { z } from 'zod'
import { exportPeriod } from '../modules/periods'
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const result = await exportPeriod(z.uuid().parse(getQuery(event).id))
  setHeader(
    event,
    'Content-Disposition',
    `attachment; filename="lad-period-${result.closure.month}-v${result.closure.generation}.json"`,
  )
  return result
})
