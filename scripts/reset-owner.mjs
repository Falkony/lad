import { createRequire } from 'node:module'
const load = createRequire(new URL('../.output/server/package.json', import.meta.url))
import { resolve } from 'node:path'
import { open, readFile, unlink } from 'node:fs/promises'
import { validPasswordHash } from './password.mjs'
if (!process.argv.includes('--confirm-reset'))
  throw new Error('Pass --confirm-reset to replace the owner password and revoke sessions')
const hash = process.env.LAD_OWNER_PASSWORD_HASH
if (!validPasswordHash(hash)) throw new Error('Set LAD_OWNER_PASSWORD_HASH using npm run auth:hash')
async function reset(query) {
  const rows = await query('SELECT owner_id FROM auth_workspaces LIMIT 1', []),
    id = rows[0]?.owner_id
  if (!id) throw new Error('Owner is not initialized')
  await query('UPDATE auth_users SET password_hash=$1 WHERE id=$2', [hash, id])
  await query('DELETE FROM auth_sessions WHERE user_id=$1', [id])
}
let close,
  lockPath,
  lockOwner,
  locked = false
try {
  if (process.env.DATABASE_URL) {
    const postgres = load('postgres'),
      client = postgres(process.env.DATABASE_URL, { max: 1 })
    close = () => client.end()
    await client.begin(async (tx) => {
      await tx.unsafe('SELECT id FROM auth_workspaces FOR UPDATE')
      await reset((sql, params) => tx.unsafe(sql, params))
    })
  } else {
    if (!process.env.LAD_DATA_DIR)
      throw new Error('Set an explicit LAD_DATA_DIR and stop the application first')
    const dataDir = resolve(process.env.LAD_DATA_DIR)
    lockPath = `${dataDir}.lock`
    lockOwner = String(process.pid)
    const lock = await open(lockPath, 'wx')
    locked = true
    await lock.writeFile(lockOwner)
    await lock.close()
    const { PGlite } = load('@electric-sql/pglite'),
      client = new PGlite(dataDir)
    close = () => client.close()
    await client.transaction(async (tx) =>
      reset(async (sql, params) => (await tx.query(sql, params)).rows),
    )
  }
  process.stdout.write('Пароль владельца изменён, все сессии завершены.\n')
} catch (error) {
  process.stderr.write(
    error.code === 'EEXIST'
      ? 'База уже заблокирована. Остановите приложение.\n'
      : error.message + '\n',
  )
  process.exitCode = 1
} finally {
  await close?.()
  if (
    locked &&
    lockPath &&
    lockOwner &&
    (await readFile(lockPath, 'utf8').catch(() => '')) === lockOwner
  )
    await unlink(lockPath)
}
