// Keep this unauthenticated MVP bound to loopback, including production previews.
process.env.NITRO_HOST = '127.0.0.1'
process.env.NITRO_PORT ||= '3000'
await import('../.output/server/index.mjs')
