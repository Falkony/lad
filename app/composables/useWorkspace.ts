import type { Workspace } from '../../shared/types'
import type { CommandResult } from '../../shared/planning-types'
const empty = (): Workspace => ({
  accounts: [],
  transactions: [],
  deletedTransactions: [],
  goals: [],
  events: [],
  shopping: [],
  obligations: [],
  isDemo: false,
  revision: '0',
  budgets: [],
  recurringPayments: [],
  recurringVersions: [],
  paymentOccurrences: [],
})
export function useWorkspace() {
  const workspace = useState<Workspace>('workspace', empty)
  const loading = useState('workspace-loading', () => true)
  const pending = useState('workspace-pending', () => false)
  const error = useState('workspace-error', () => '')
  const toast = useState('workspace-toast', () => '')
  const refreshVersion = useState('workspace-refresh-version', () => 0)
  async function refresh() {
    const version = ++refreshVersion.value
    loading.value = true
    try {
      const value = await $fetch<Workspace>('/api/workspace')
      if (version === refreshVersion.value) {
        workspace.value = value
        error.value = ''
      }
    } catch (failure: any) {
      if (version === refreshVersion.value) {
        const status = failure?.statusCode || failure?.response?.status
        error.value =
          status >= 500
            ? 'Сервер работает, но при загрузке данных произошла ошибка. Повторите попытку.'
            : status === 403
              ? 'Сервер отклонил доступ к данным. Откройте приложение через localhost или 127.0.0.1.'
              : 'Не удалось подключиться к серверу. Проверьте, запущено ли приложение.'
      }
    } finally {
      if (version === refreshVersion.value) loading.value = false
    }
  }
  async function command(payload: Record<string, unknown>, message = '') {
    if (pending.value) throw new Error('Дождитесь завершения операции')
    pending.value = true
    try {
      const result = await $fetch<CommandResult>('/api/command', { method: 'POST', body: payload })
      await refresh()
      if (message) notify(message)
      return result
    } catch (err: any) {
      const message =
        err?.data?.data?.issues?.[0]?.message ||
        err?.data?.message ||
        'Не удалось сохранить изменения'
      notify(message)
      throw new Error(message)
    } finally {
      pending.value = false
    }
  }
  function notify(message: string) {
    toast.value = message
    setTimeout(() => {
      if (toast.value === message) toast.value = ''
    }, 4500)
  }
  return { workspace, loading, pending, error, toast, refresh, command, notify }
}
