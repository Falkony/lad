if (!['0', '1', undefined].includes(process.env.LAD_AUTH_ENABLED))
  throw new Error('LAD_AUTH_ENABLED must be 0 or 1')
const hosted = process.env.LAD_AUTH_ENABLED === '1'
if (hosted && !process.env.LAD_PUBLIC_ORIGIN)
  throw new Error('Set LAD_PUBLIC_ORIGIN before hosted startup')
const localHTTP = hosted && new URL(process.env.LAD_PUBLIC_ORIGIN).protocol === 'http:'
process.env.NITRO_HOST = hosted && !localHTTP ? process.env.NITRO_HOST || '0.0.0.0' : '127.0.0.1'
process.env.NITRO_PORT ||= '3000'
await import('../.output/server/index.mjs')
