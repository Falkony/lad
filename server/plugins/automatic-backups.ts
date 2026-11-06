import { flushWorkspaceCommands, getWorkspaceBackups } from '../modules/workspace'

export default defineNitroPlugin((nitroApp) => {
  const backups = getWorkspaceBackups()
  // This Nitro version does not await plugin promises. Commands also await this shared queue
  // before writing, so the startup snapshot cannot race the first mutation.
  void backups.start()
  nitroApp.hooks.hook('close', async () => {
    await flushWorkspaceCommands()
  })
})
