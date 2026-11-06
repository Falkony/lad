import type { Backup } from '../../shared/backup'
export function useBackup() {
  const exporting = useState('backup-exporting', () => false)
  const { notify } = useWorkspace()
  async function downloadBackup() {
    if (exporting.value) return
    exporting.value = true
    try {
      const data = await $fetch<Backup>('/api/backup')
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `lad-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      notify('Резервная копия скачана')
    } catch {
      notify('Не удалось скачать резервную копию')
    } finally {
      exporting.value = false
    }
  }
  return { exporting, downloadBackup }
}
