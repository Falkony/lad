import { randomBytes, createHash } from 'node:crypto'
import { and, eq, lt, desc } from 'drizzle-orm'
import { createError, getHeader, getCookie, setCookie, deleteCookie, type H3Event } from 'h3'
import { z } from 'zod'
import { getDb, type WriteTransaction } from '../db'
import {
  authUsers,
  authWorkspaces,
  authMemberships,
  authSessions,
  authLoginAttempts,
} from '../db/schema'
import { hashPassword, verifyPassword, validPasswordHash } from '../../scripts/password.mjs'
import type { AuthActor, AuthStatus, DeviceSession } from '../../shared/auth'
export const sessionCookie = '__Host-lad_session'
export const sessionCookieName = () => (authOptions().secure ? sessionCookie : 'lad_session')
const sessionLifetime = 7 * 86400000,
  windowMs = 15 * 60000
const dummyHash = 'scrypt$32768$8$3$' + '0'.repeat(32) + '$' + '0'.repeat(128)
const fail = (statusCode: number, message: string) => createError({ statusCode, message })
export function authOptions() {
  const value = process.env.LAD_AUTH_ENABLED
  if (value && !['0', '1'].includes(value)) throw fail(503, 'Неверный режим доступа на сервере')
  if (value !== '1') return { enabled: false as const, origin: null, secure: false }
  let url: URL
  try {
    url = new URL(process.env.LAD_PUBLIC_ORIGIN || '')
  } catch {
    throw fail(503, 'Адрес сервера для входа ещё не настроен')
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw fail(503, 'Неверный адрес сервера для входа')
  const localHTTP =
    url.protocol === 'http:' &&
    process.env.LAD_AUTH_ALLOW_HTTP === '1' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHTTP) throw fail(503, 'Для удалённого входа нужен HTTPS')
  return { enabled: true as const, origin: url.origin, secure: url.protocol === 'https:' }
}
let ownerInitialization: Promise<void> | undefined
export async function ensureOwner() {
  if (!authOptions().enabled) return
  ownerInitialization ??= (async () => {
    const db = await getDb()
    await db.transaction(async (tx) => {
      const [space] = await tx.select().from(authWorkspaces).for('update')
      if (!space) throw fail(503, 'Пространство не подготовлено')
      if (space.ownerId) return
      const username = process.env.LAD_OWNER_LOGIN?.toLowerCase(),
        passwordHash = process.env.LAD_OWNER_PASSWORD_HASH
      if (!username || !/^[-a-z0-9_.]{3,64}$/.test(username) || !validPasswordHash(passwordHash))
        throw fail(503, 'Первый владелец ещё не настроен на сервере')
      const userId = crypto.randomUUID()
      await tx
        .insert(authUsers)
        .values({ id: userId, username, passwordHash, createdAt: new Date().toISOString() })
      await tx
        .update(authWorkspaces)
        .set({ ownerId: userId })
        .where(eq(authWorkspaces.id, space.id))
      await tx
        .insert(authMemberships)
        .values({ id: crypto.randomUUID(), workspaceId: space.id, userId, role: 'owner' })
    })
  })().catch((error) => {
    ownerInitialization = undefined
    throw error
  })
  await ownerInitialization
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const validToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
export async function actorForToken(
  token: string | undefined,
  now = Date.now(),
): Promise<AuthActor | null> {
  if (!validToken(token)) return null
  await ensureOwner()
  const db = await getDb()
  const [row] = await db
    .select({
      session: authSessions,
      user: authUsers,
      member: authMemberships,
      space: authWorkspaces,
    })
    .from(authSessions)
    .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
    .innerJoin(
      authMemberships,
      and(
        eq(authMemberships.userId, authSessions.userId),
        eq(authMemberships.workspaceId, authSessions.workspaceId),
      ),
    )
    .innerJoin(authWorkspaces, eq(authWorkspaces.id, authSessions.workspaceId))
    .where(eq(authSessions.tokenHash, tokenHash(token)))
  if (!row || Date.parse(row.session.expiresAt) <= now) return null
  return {
    userId: row.user.id,
    username: row.user.username,
    sessionId: row.session.id,
    workspaceId: row.space.id,
    role: row.member.role as AuthActor['role'],
  }
}
/** Recheck queued writes after middleware: a revoked session cannot finish a later command. */
export async function assertCommandActor(
  db: WriteTransaction,
  actor: AuthActor | undefined,
  op: string,
) {
  if (!authOptions().enabled) return
  if (!actor) throw fail(401, 'Войдите в приложение')
  const [session] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, actor.sessionId)),
    [space] = await db.select().from(authWorkspaces),
    [member] = await db
      .select()
      .from(authMemberships)
      .where(
        and(
          eq(authMemberships.userId, actor.userId),
          eq(authMemberships.workspaceId, actor.workspaceId),
        ),
      )
  if (
    !session ||
    session.userId !== actor.userId ||
    session.workspaceId !== actor.workspaceId ||
    space?.id !== actor.workspaceId ||
    Date.parse(session.expiresAt) <= Date.now() ||
    !member
  )
    throw fail(401, 'Сессия завершена. Войдите снова')
  if (member.role === 'viewer') throw fail(403, 'В этом пространстве доступно только чтение')
  if (['workspace.reset', 'workspace.restore'].includes(op) && member.role !== 'owner')
    throw fail(403, 'Это действие доступно владельцу пространства')
}
export function requireActor(event: H3Event) {
  const actor = event.context.auth as AuthActor | undefined
  if (!actor) throw fail(401, 'Войдите в приложение')
  return actor
}
export function apiPath(event: H3Event) {
  let path = event.path.split('?')[0]!
  try {
    for (let i = 0; i < 3; i++) {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    }
  } catch {
    throw fail(400, 'Некорректный адрес запроса')
  }
  path = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  return new URL(path, 'http://local').pathname.toLowerCase()
}
export const isApiPath = (path: string) => path === '/api' || path.startsWith('/api/')
export async function enforceApiAccess(event: H3Event) {
  const path = apiPath(event)
  if (!isApiPath(path)) return
  const host = getHeader(event, 'host') || '',
    origin = getHeader(event, 'origin'),
    site = getHeader(event, 'sec-fetch-site')
  if (site && !['same-origin', 'none'].includes(site))
    throw fail(403, 'Недопустимый источник запроса')
  const options = authOptions()
  if (options.enabled && !options.secure) {
    const address = event.node.req.socket?.remoteAddress
    if (address && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address))
      throw fail(403, 'Тестовый вход по HTTP доступен только локально')
  }
  if (!options.enabled) {
    const address = event.node.req.socket?.remoteAddress
    if (address && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address))
      throw fail(403, 'Эта версия работает только локально')
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname))
      throw fail(403, 'Эта версия работает только локально')
    if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {}
      if (originHost !== host) throw fail(403, 'Недопустимый источник запроса')
    }
    return
  }
  if (host.toLowerCase() !== new URL(options.origin!).host.toLowerCase())
    throw fail(403, 'Недопустимый адрес сервера')
  if (origin && origin !== options.origin) throw fail(403, 'Недопустимый источник запроса')
  const write = !['GET', 'HEAD'].includes(event.method)
  if (write && origin !== options.origin)
    throw fail(403, 'Для изменения данных откройте приложение по его адресу')
  await ensureOwner()
  if (['/api/auth/status', '/api/auth/login'].includes(path)) return
  const actor = await actorForToken(getCookie(event, sessionCookieName()))
  if (!actor) throw fail(401, 'Войдите в приложение')
  if (write && actor.role === 'viewer' && !path.startsWith('/api/auth/'))
    throw fail(403, 'В этом пространстве доступно только чтение')
  event.context.auth = actor
}
async function consumeLoginAttempt(key: string, now = Date.now()) {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.select().from(authWorkspaces).for('update')
    const stamp = new Date(now).toISOString()
    await tx
      .delete(authLoginAttempts)
      .where(lt(authLoginAttempts.startedAt, new Date(now - 86400000).toISOString()))
    for (const [id, limit] of [
      ['global', 60],
      [key, 10],
    ] as const) {
      const [row] = await tx.select().from(authLoginAttempts).where(eq(authLoginAttempts.key, id))
      const same = !!row && now - Date.parse(row.startedAt) < windowMs
      if (same && row.count >= limit)
        throw fail(429, 'Слишком много попыток входа. Повторите позже')
      await tx
        .insert(authLoginAttempts)
        .values({
          key: id,
          count: same ? row.count + 1 : 1,
          startedAt: same ? row.startedAt : stamp,
        })
        .onConflictDoUpdate({
          target: authLoginAttempts.key,
          set: { count: same ? row.count + 1 : 1, startedAt: same ? row.startedAt : stamp },
        })
    }
  })
}
async function newSession(
  db: WriteTransaction,
  userId: string,
  workspaceId: string,
  deviceName: string,
  oldToken?: string,
) {
  const now = new Date().toISOString()
  await db.delete(authSessions).where(lt(authSessions.expiresAt, now))
  if (oldToken && validToken(oldToken))
    await db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash(oldToken)))
  const previous = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
    .orderBy(desc(authSessions.createdAt))
  for (const s of previous.slice(19)) await db.delete(authSessions).where(eq(authSessions.id, s.id))
  const token = randomBytes(32).toString('base64url'),
    id = crypto.randomUUID(),
    expiresAt = new Date(Date.now() + sessionLifetime).toISOString()
  await db.insert(authSessions).values({
    id,
    userId,
    workspaceId,
    tokenHash: tokenHash(token),
    deviceName: deviceName.slice(0, 120),
    createdAt: now,
    expiresAt,
  })
  return { token, id, expiresAt }
}
const usernameSchema = z
  .string()
  .trim()
  .regex(/^[-a-zA-Z0-9_.]{3,64}$/)
  .transform((s) => s.toLowerCase())
export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(256),
  deviceName: z.string().trim().max(80).default(''),
})
export async function login(input: z.infer<typeof loginSchema>, peer: string, oldToken?: string) {
  if (!authOptions().enabled) throw fail(400, 'Локальный режим не требует входа')
  await ensureOwner()
  await consumeLoginAttempt('peer:' + tokenHash(peer))
  const db = await getDb(),
    [user] = await db.select().from(authUsers).where(eq(authUsers.username, input.username))
  const matches = await verifyPassword(input.password, user?.passwordHash || dummyHash)
  if (!user || !matches) throw fail(401, 'Неверное имя или пароль')
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, user.id))
      .for('update')
    if (!current || current.passwordHash !== user.passwordHash)
      throw fail(401, 'Пароль изменился. Войдите снова')
    const [space] = await tx.select().from(authWorkspaces),
      [member] = await tx
        .select()
        .from(authMemberships)
        .where(and(eq(authMemberships.userId, user.id), eq(authMemberships.workspaceId, space!.id)))
    if (!member) throw fail(403, 'Нет доступа к пространству')
    return newSession(tx, user.id, space!.id, input.deviceName || 'Браузер', oldToken)
  })
}
export function writeSessionCookie(event: H3Event, token: string) {
  setCookie(event, sessionCookieName(), token, {
    httpOnly: true,
    secure: authOptions().secure,
    sameSite: 'strict',
    path: '/',
    maxAge: sessionLifetime / 1000,
  })
}
export function clearSessionCookie(event: H3Event) {
  deleteCookie(event, sessionCookieName(), {
    path: '/',
    secure: authOptions().secure,
    httpOnly: true,
    sameSite: 'strict',
  })
}
export async function authStatus(event: H3Event): Promise<AuthStatus> {
  const enabled = authOptions().enabled
  if (!enabled) return { enabled: false, authenticated: true, user: null }
  const actor = await actorForToken(getCookie(event, sessionCookieName()))
  return {
    enabled: true,
    authenticated: !!actor,
    user: actor
      ? {
          id: actor.userId,
          username: actor.username,
          workspaceId: actor.workspaceId,
          role: actor.role,
        }
      : null,
  }
}
export async function logout(event: H3Event) {
  const actor = requireActor(event),
    db = await getDb()
  await db.delete(authSessions).where(eq(authSessions.id, actor.sessionId))
  clearSessionCookie(event)
}
export async function listSessions(actor: AuthActor): Promise<DeviceSession[]> {
  const db = await getDb()
  return (
    await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, actor.userId))
      .orderBy(desc(authSessions.createdAt))
  )
    .filter((s) => Date.parse(s.expiresAt) > Date.now())
    .map((s) => ({
      id: s.id,
      deviceName: s.deviceName,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      current: s.id === actor.sessionId,
    }))
}
export async function revokeSession(actor: AuthActor, id: string) {
  const db = await getDb()
  await db
    .delete(authSessions)
    .where(and(eq(authSessions.id, id), eq(authSessions.userId, actor.userId)))
}
export async function changePassword(
  actor: AuthActor,
  currentPassword: string,
  newPassword: string,
) {
  const db = await getDb()
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, actor.userId))
      .for('update')
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash)))
      throw fail(401, 'Неверный текущий пароль')
    const hash = await hashPassword(newPassword)
    await tx.update(authUsers).set({ passwordHash: hash }).where(eq(authUsers.id, user.id))
    await tx.delete(authSessions).where(eq(authSessions.userId, user.id))
    return newSession(tx, user.id, actor.workspaceId, 'После смены пароля')
  })
}
