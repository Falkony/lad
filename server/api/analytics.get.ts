import { monthSchema } from '../../shared/planning-schemas'
import { readPeriodAnalysis } from '../modules/periods'
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const q = getQuery(event)
  return readPeriodAnalysis(
    monthSchema.parse(q.month),
    q.compare ? monthSchema.parse(q.compare) : undefined,
  )
})
