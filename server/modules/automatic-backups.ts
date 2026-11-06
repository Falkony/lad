import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { backupMaxBytes, backupSchema, createBackup } from '../../shared/backup'
import type { Workspace } from '../../shared/types'
import type { AutomaticBackupFile, AutomaticBackupStatus } from '../../shared/automatic-backups'

// Only files created by this service participate in rotation or can be downloaded by name.
const filenamePattern =
  /^lad-auto-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/

export interface AutomaticBackupOptions {
  directory: string
  every: number
  keep: number
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (!value) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${name} должен быть положительным целым числом`)
  return number
}

export function automaticBackupOptions(): AutomaticBackupOptions {
  const keep = positiveInteger(process.env.LAD_BACKUP_KEEP, 20, 'LAD_BACKUP_KEEP')
  if (keep < 2)
    throw new Error(
      'LAD_BACKUP_KEEP должен быть не меньше 2 для сохранения копии перед заменой данных',
    )
  return {
    directory: resolve(
      process.env.LAD_BACKUP_DIR ||
        join(dirname(resolve(process.env.LAD_DATA_DIR || '.data/lad')), 'backups'),
    ),
    every: positiveInteger(process.env.LAD_BACKUP_EVERY, 10, 'LAD_BACKUP_EVERY'),
    keep,
  }
}

export function createAutomaticBackups(
  readWorkspace: () => Promise<Workspace>,
  options: AutomaticBackupOptions,
) {
  const directory = resolve(options.directory)
  let queue = Promise.resolve(true)
  let started = false
  let changes = 0
  let lastTimestamp = 0
  let error: string | null = null

  async function files(): Promise<AutomaticBackupFile[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((failure) => {
      if (failure.code === 'ENOENT') return []
      throw failure
    })
    return entries
      .filter((entry) => entry.isFile() && filenamePattern.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        createdAt: new Date(Number(filenamePattern.exec(entry.name)![1])).toISOString(),
      }))
      .sort((a, b) => b.name.localeCompare(a.name))
  }

  // The queue always settles: a failed copy must not turn a committed command into an API error.
  function enqueue(task: () => Promise<void>) {
    queue = queue.then(async () => {
      try {
        await task()
        return true
      } catch (failure) {
        error =
          'Не удалось завершить автоматическое копирование. Проверьте папку копий и свободное место.'
        console.error('[lad] automatic backup failed', failure)
        return false
      }
    })
    return queue
  }

  async function save() {
    const snapshot = await readWorkspace()
    const backup = createBackup(snapshot)
    backupSchema.parse(backup)
    const contents = JSON.stringify(backup, null, 2)
    if (Buffer.byteLength(contents) > backupMaxBytes)
      throw new Error('Автоматическая копия превышает предел восстановления 25 МБ')
    await mkdir(directory, { recursive: true })
    const previous = await files()
    // Strictly increasing timestamps keep rotation deterministic even in the same millisecond
    // or after a clock correction/restart. The JSON itself carries the actual exportedAt.
    const latest = previous[0] ? Number(filenamePattern.exec(previous[0].name)![1]) : 0
    lastTimestamp = Math.max(Date.now(), latest + 1, lastTimestamp + 1)
    const name = `lad-auto-${lastTimestamp}-${randomUUID()}.json`
    const temporary = join(directory, `${name}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(contents, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      const persisted = await readFile(temporary, 'utf8')
      if (persisted !== contents) throw new Error('Сохранённая копия отличается от снимка')
      backupSchema.parse(JSON.parse(persisted))
      await rename(temporary, join(directory, name))
    } finally {
      await rm(temporary, { force: true })
    }
    changes = 0
    // Rotate only after publishing a fully written, validated replacement. No recursive deletes.
    for (const old of (await files()).slice(options.keep)) await rm(join(directory, old.name))
    error = null
  }

  function start() {
    if (started) return queue
    started = true
    return enqueue(save)
  }

  return {
    start,
    afterChange() {
      return enqueue(async () => {
        changes++
        if (changes >= options.every || error) await save()
      })
    },
    // Callers may block a destructive action when its safety copy failed.
    capture() {
      return enqueue(save)
    },
    flush: () => queue,
    async status(): Promise<AutomaticBackupStatus> {
      await queue
      let available: AutomaticBackupFile[] = []
      try {
        available = await files()
      } catch {
        error = 'Не удалось прочитать папку автоматических копий. Проверьте доступ к ней.'
      }
      return { directory, every: options.every, keep: options.keep, files: available, error }
    },
    async read(name: string) {
      await queue
      if (!filenamePattern.test(name) || !(await files()).some((file) => file.name === name))
        throw new Error('Автоматическая копия не найдена')
      const filename = join(directory, name)
      if ((await stat(filename)).size > backupMaxBytes) throw new Error('Копия больше 25 МБ')
      return backupSchema.parse(JSON.parse(await readFile(filename, 'utf8')))
    },
  }
}
