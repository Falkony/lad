import { describe, expect, it } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import localOnly from '../server/middleware/local-only'

const app = createApp()
  .use(localOnly)
  .use(eventHandler(() => ({ ok: true })))
const handle = toWebHandler(app)
function request(host: string, origin?: string) {
  return handle(
    new Request(`http://${host}/api/workspace`, {
      headers: { host, ...(origin ? { origin } : {}) },
    }),
  )
}
describe('local API boundary, including dev requests without native socket metadata', () => {
  it('accepts same-origin loopback requests', async () => {
    const response = await request('127.0.0.1:3000', 'http://127.0.0.1:3000')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
  it('rejects a foreign origin even with a local Host', async () => {
    expect((await request('127.0.0.1:3000', 'https://evil.example')).status).toBe(403)
  })
  it('rejects foreign Host names', async () => {
    expect((await request('evil.example')).status).toBe(403)
  })
})
