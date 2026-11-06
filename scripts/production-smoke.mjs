// Backend verification only: an isolated database and API requests, without opening a browser.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import assert from 'node:assert/strict'
import { hashPassword } from './password.mjs'
const temporary = await mkdtemp(join(tmpdir(), 'lad-production-check-'))
const probe = createServer()
await new Promise((ok, bad) => {
  probe.once('error', bad)
  probe.listen(0, '127.0.0.1', ok)
})
const port = probe.address().port
await new Promise((ok) => probe.close(ok))
const origin = `http://127.0.0.1:${port}`,
  password = 'Temporary production API test 2026',
  hash = await hashPassword(password)
const child = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: process.cwd(),
  windowsHide: true,
  env: {
    ...process.env,
    DATABASE_URL: '',
    LAD_DATA_DIR: join(temporary, 'db'),
    LAD_BACKUP_DIR: join(temporary, 'backups'),
    LAD_AUTH_ENABLED: '1',
    LAD_AUTH_ALLOW_HTTP: '1',
    LAD_PUBLIC_ORIGIN: origin,
    LAD_OWNER_LOGIN: 'owner',
    LAD_OWNER_PASSWORD_HASH: hash,
    NITRO_HOST: '127.0.0.1',
    NITRO_PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const stopped = new Promise((ok) => child.once('exit', ok))
let output = ''
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    output = (output + chunk).slice(-12000)
  })
async function request(path, method = 'GET', body, cookie) {
  return fetch(origin + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json', origin } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  })
}
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Server exited before readiness')
    try {
      const response = await request('/api/auth/status')
      if (response.ok) {
        ready = true
        break
      }
    } catch {}
    await new Promise((ok) => setTimeout(ok, 150))
  }
  assert(ready, 'Server did not become ready')
  assert.equal((await request('/api/workspace')).status, 401)
  const login = await request('/api/auth/login', 'POST', {
    username: 'owner',
    password,
    deviceName: 'Production smoke',
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert(login.headers.get('set-cookie').includes('HttpOnly'))
  async function command(body) {
    const response = await request('/api/command', 'POST', body, cookie)
    assert.equal(response.status, 200, await response.text())
    return response
  }
  await command({
    op: 'account.create',
    data: { name: 'Проверочный счёт', openingBalance: '100000' },
  })
  let w = await (await request('/api/workspace', 'GET', undefined, cookie)).json()
  await command({
    op: 'transaction.create',
    data: {
      kind: 'expense',
      accountId: w.accounts[0].id,
      amount: '123',
      category: 'Дом',
      description: 'Проверка восстановления',
      date: new Date().toISOString().slice(0, 10),
    },
  })
  const backup = await (await request('/api/backup', 'GET', undefined, cookie)).json()
  assert.equal(backup.transactions.length, 1)
  assert.equal(backup.commandHistory.at(-1).actorName, 'owner')
  assert(!JSON.stringify(backup).includes(hash))
  assert(!JSON.stringify(backup).includes('passwordHash'))
  await command({ op: 'workspace.reset', confirmation: 'УДАЛИТЬ' })
  w = await (await request('/api/workspace', 'GET', undefined, cookie)).json()
  assert.equal(w.accounts.length, 0)
  await command({
    op: 'workspace.restore',
    backup,
    expectedRevision: w.revision,
    confirmation: 'ВОССТАНОВИТЬ',
  })
  w = await (await request('/api/workspace', 'GET', undefined, cookie)).json()
  assert.equal(w.accounts[0].id, backup.accounts[0].id)
  assert.equal(w.transactions[0].amount, '123')
  assert((await (await request('/api/auth/status', 'GET', undefined, cookie)).json()).authenticated)
  const copies = await (await request('/api/backups', 'GET', undefined, cookie)).json()
  assert(copies.files.length >= 2)
  process.stdout.write('Production API, authentication and backup restore passed.\n')
} catch (error) {
  process.stderr.write(output + '\n' + error.stack + '\n')
  process.exitCode = 1
} finally {
  if (child.exitCode === null) child.kill('SIGTERM')
  await stopped
  const root = await realpath(tmpdir()),
    target = await realpath(temporary)
  if (dirname(target) !== root || !basename(target).startsWith('lad-production-check-'))
    throw new Error('Refusing cleanup outside the dedicated test directory')
  await rm(target, { recursive: true, force: true })
}
