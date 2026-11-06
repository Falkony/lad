import { readTransactions } from '../modules/transaction-pages'
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return readTransactions(getQuery(event))
})
