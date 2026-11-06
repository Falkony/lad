import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createApp,
  createRouter,
  eventHandler,
  toWebHandler,
  setHeader,
  getQuery,
  createError,
} from 'h3'
import { eq } from 'drizzle-orm'
import localOnly from '../server/middleware/local-only'
import { getDb } from '../server/db'
import {
  authUsers,
  authWorkspaces,
  authMemberships,
  authSessions,
  authLoginAttempts,
  accounts,
  commandHistory,
} from '../server/db/schema'
import { commandSchema, executeCommand, readWorkspace } from '../server/modules/workspace'
import {
  authOptions,
  ensureOwner,
  login,
  actorForToken,
  changePassword,
  revokeSession,
  listSessions,
} from '../server/modules/auth'
import { hashPassword, verifyPassword } from '../scripts/password.mjs'
import { createBackup, backupSchema } from '../shared/backup'
import { readCommandHistory } from '../server/modules/command-history'
import type { AuthActor } from '../shared/auth'
const password = 'Test password number 2026',
  origin = 'https://finance.example',
  run = (c: unknown, actor?: AuthActor) => executeCommand(commandSchema.parse(c), actor)
let ownerHash: string, handle: ReturnType<typeof toWebHandler>
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'lad-auth-'))
  process.env.LAD_DATA_DIR = join(root, 'db')
  process.env.LAD_BACKUP_DIR = join(root, 'backups')
  delete process.env.DATABASE_URL
  process.env.LAD_AUTH_ENABLED = '1'
  process.env.LAD_PUBLIC_ORIGIN = origin
  process.env.LAD_OWNER_LOGIN = 'owner'
  ownerHash = await hashPassword(password)
  process.env.LAD_OWNER_PASSWORD_HASH = ownerHash
  await ensureOwner()
  vi.stubGlobal('defineEventHandler', eventHandler)
  vi.stubGlobal('setHeader', setHeader)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('createError', createError)
  const router = createRouter()
  router.get('/api/auth/status', (await import('../server/api/auth/status.get')).default)
  router.post('/api/auth/login', (await import('../server/api/auth/login.post')).default)
  router.post('/api/auth/password', (await import('../server/api/auth/password.post')).default)
  router.post('/api/auth/logout', (await import('../server/api/auth/logout.post')).default)
  router.post('/api/auth/revoke', (await import('../server/api/auth/revoke.post')).default)
  router.get('/api/auth/sessions', (await import('../server/api/auth/sessions.get')).default)
  router.get('/api/workspace', (await import('../server/api/workspace.get')).default)
  router.post('/api/command', (await import('../server/api/command.post')).default)
  handle = toWebHandler(createApp().use(localOnly).use(router))
})
beforeEach(async () => {
  const db = await getDb()
  await db.delete(authSessions)
  await db.delete(authLoginAttempts)
  const [space] = await db.select().from(authWorkspaces)
  await db
    .update(authUsers)
    .set({ passwordHash: ownerHash })
    .where(eq(authUsers.id, space!.ownerId!))
  await db.update(authMemberships).set({ role: 'owner' })
  process.env.LAD_AUTH_ENABLED = '0'
  await run({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  process.env.LAD_AUTH_ENABLED = '1'
})
afterAll(() => {
  for (const name of [
    'LAD_AUTH_ENABLED',
    'LAD_PUBLIC_ORIGIN',
    'LAD_OWNER_LOGIN',
    'LAD_OWNER_PASSWORD_HASH',
  ])
    delete process.env[name]
  vi.unstubAllGlobals()
})
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return handle(
    new Request(origin + path, {
      method,
      headers: {
        host: 'finance.example',
        ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
async function session() {
  const s = await login({ username: 'owner', password, deviceName: 'Тест' }, 'test')
  return { ...s, actor: (await actorForToken(s.token))! }
}
describe('hosted authentication and workspace isolation', () => {
  it('uses salted scrypt hashes and verifies a wrong password without storing clear text', async () => {
    const second = await hashPassword(password)
    expect(second).not.toBe(ownerHash)
    expect(second).not.toContain(password)
    expect(await verifyPassword(password, ownerHash)).toBe(true)
    expect(await verifyPassword('wrong', ownerHash)).toBe(false)
    await expect(hashPassword('short')).rejects.toThrow('12')
  })
  it('rejects insecure remote configuration and keeps an explicit loopback test exception', () => {
    process.env.LAD_PUBLIC_ORIGIN = 'http://finance.example'
    expect(() => authOptions()).toThrow('HTTPS')
    process.env.LAD_AUTH_ALLOW_HTTP = '1'
    expect(() => authOptions()).toThrow('HTTPS')
    process.env.LAD_PUBLIC_ORIGIN = 'http://127.0.0.1:3000'
    expect(authOptions().secure).toBe(false)
    delete process.env.LAD_AUTH_ALLOW_HTTP
    process.env.LAD_PUBLIC_ORIGIN = origin
  })
  it('requires a session for every financial API but exposes only a minimal login status', async () => {
    expect((await request('/api/workspace')).status).toBe(401)
    expect((await request('/api/command', 'POST', { op: 'demo.load' })).status).toBe(401)
    const response = await request('/api/auth/status')
    expect(await response.json()).toEqual({ enabled: true, authenticated: false, user: null })
  })
  it('sets HttpOnly, Secure and SameSite cookies without returning tokens in JSON', async () => {
    const response = await request('/api/auth/login', 'POST', {
      username: 'owner',
      password,
      deviceName: 'Телефон',
    })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
    expect(await response.json()).toEqual({ ok: true })
    expect((await request('/api/workspace', 'GET', undefined, cookie.split(';')[0])).status).toBe(
      200,
    )
    const db = await getDb(),
      [stored] = await db.select().from(authSessions)
    expect(stored!.tokenHash).not.toContain(cookie.split('=')[1]!.split(';')[0]!)
    expect(stored!.tokenHash).toHaveLength(64)
  })
  it('rejects foreign and missing mutation origins and ignores spoofed forwarding headers', async () => {
    const s = await session(),
      cookie = '__Host-lad_session=' + s.token
    expect(
      (
        await request('/api/command', 'POST', { op: 'demo.load' }, cookie, {
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403)
    expect(
      (await request('/api/command', 'POST', { op: 'demo.load' }, cookie, { origin: '' })).status,
    ).toBe(403)
    expect(
      (
        await request('/api/workspace', 'GET', undefined, cookie, {
          host: 'evil.example',
          'x-forwarded-host': 'finance.example',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request('/api/workspace', 'GET', undefined, cookie, {
          'sec-fetch-site': 'cross-site',
        })
      ).status,
    ).toBe(403)
  })
  it('protects encoded and case-varied API paths before route matching', async () => {
    for (const path of [
      '/%61pi/workspace',
      '/API/workspace',
      '/api%2Fworkspace',
      '//api/workspace',
    ])
      expect([401, 404]).toContain((await request(path)).status)
  })
  it('expires and revokes device sessions, listing no token hashes', async () => {
    const s = await session()
    expect(await actorForToken(s.token, Date.parse(s.expiresAt) + 1)).toBeNull()
    const list = await listSessions(s.actor)
    expect(list[0]).toMatchObject({ current: true, deviceName: 'Тест' })
    expect(JSON.stringify(list)).not.toContain('tokenHash')
    await revokeSession(s.actor, s.id)
    expect(await actorForToken(s.token)).toBeNull()
  })
  it('changes the password and invalidates every old device while keeping a new current session', async () => {
    const a = await session(),
      b = await session()
    const replacement = await changePassword(a.actor, password, password + ' changed')
    expect(await actorForToken(a.token)).toBeNull()
    expect(await actorForToken(b.token)).toBeNull()
    expect(await actorForToken(replacement.token)).not.toBeNull()
    await expect(login({ username: 'owner', password, deviceName: '' }, 'old')).rejects.toThrow(
      'Неверное',
    )
    expect(
      (await login({ username: 'owner', password: password + ' changed', deviceName: '' }, 'new'))
        .token,
    ).toHaveLength(43)
  })
  it('rechecks revocation and membership inside a financial transaction', async () => {
    const s = await session()
    await revokeSession(s.actor, s.id)
    const before = (await readWorkspace()).revision
    await expect(
      run({ op: 'account.create', data: { name: 'Запрещено', openingBalance: '0' } }, s.actor),
    ).rejects.toThrow('Сессия')
    expect((await readWorkspace()).revision).toBe(before)
  })
  it('rejects forged workspace actors and viewer writes even with a formerly owner-shaped actor', async () => {
    const s = await session()
    await expect(
      run({ op: 'demo.load' }, { ...s.actor, workspaceId: crypto.randomUUID() }),
    ).rejects.toThrow('Сессия')
    const db = await getDb()
    await db.update(authMemberships).set({ role: 'viewer' })
    await expect(run({ op: 'demo.load' }, s.actor)).rejects.toThrow('чтение')
    expect(
      (await request('/api/workspace', 'GET', undefined, '__Host-lad_session=' + s.token)).status,
    ).toBe(200)
  })
  it('binds all records to the server workspace and records the authenticated author', async () => {
    const s = await session()
    await run({ op: 'account.create', data: { name: 'Мой счёт', openingBalance: '1000' } }, s.actor)
    const db = await getDb(),
      [a] = await db.select().from(accounts)
    expect(a!.workspaceId).toBe(s.actor.workspaceId)
    await expect(
      db.insert(accounts).values({
        id: crypto.randomUUID(),
        name: 'Чужой',
        kind: 'cash',
        openingBalance: '0',
        color: 'green',
        workspaceId: crypto.randomUUID(),
      }),
    ).rejects.toThrow()
    const history = await readCommandHistory()
    expect(history.entries[0]).toMatchObject({ actorUserId: s.actor.userId, actorName: 'owner' })
    const backup = backupSchema.parse(createBackup(await readWorkspace(true)))
    const json = JSON.stringify(backup)
    expect(json).not.toContain(ownerHash)
    expect(json).not.toContain('tokenHash')
    expect(json).not.toContain('passwordHash')
    expect(backup.accounts[0]).not.toHaveProperty('workspaceId')
  })
  it('preserves credentials and the active session across a financial restore', async () => {
    const s = await session()
    await run({ op: 'account.create', data: { name: 'Счёт', openingBalance: '1000' } }, s.actor)
    let w = await readWorkspace()
    const backup = backupSchema.parse(createBackup(await readWorkspace(true)))
    await run(
      {
        op: 'workspace.restore',
        backup,
        expectedRevision: w.revision,
        confirmation: 'ВОССТАНОВИТЬ',
      },
      s.actor,
    )
    expect(await actorForToken(s.token)).not.toBeNull()
    const db = await getDb()
    expect((await db.select().from(authUsers))[0]!.passwordHash).toBe(ownerHash)
    expect((await readWorkspace()).accounts[0]!.openingBalance).toBe('1000')
  })
  it(
    'limits repeated login attempts and returns the same error for unknown names and wrong passwords',
    { timeout: 20000 },
    async () => {
      await expect(
        login({ username: 'unknown', password, deviceName: '' }, 'limited'),
      ).rejects.toThrow('Неверное имя или пароль')
      for (let i = 0; i < 9; i++)
        await expect(
          login({ username: 'owner', password: 'wrong', deviceName: '' }, 'limited'),
        ).rejects.toThrow('Неверное имя или пароль')
      await expect(
        login({ username: 'owner', password, deviceName: '' }, 'limited'),
      ).rejects.toMatchObject({ statusCode: 429 })
    },
  )
  it('returns validation errors without echoing credentials', async () => {
    const response = await request('/api/auth/login', 'POST', {
      username: 'owner',
      password: 'x'.repeat(300),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('x'.repeat(100))
  })
})
