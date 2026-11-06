import type { AuthStatus } from '../../shared/auth'
export function useAuth() {
  const state = useState<AuthStatus>('auth-status', () => ({
      enabled: true,
      authenticated: false,
      user: null,
    })),
    loaded = useState('auth-loaded', () => false),
    error = useState('auth-error', () => ''),
    pending = useState('auth-pending', () => false),
    signedOut = useState('auth-device-signout', () => false)
  function marker(value?: boolean) {
    if (value !== undefined) signedOut.value = value
    if (import.meta.client)
      try {
        if (value === undefined) signedOut.value = localStorage.getItem('lad.signed-out') === '1'
        else if (value) localStorage.setItem('lad.signed-out', '1')
        else localStorage.removeItem('lad.signed-out')
      } catch {}
    return signedOut.value
  }
  function invalidate() {
    state.value = { ...state.value, authenticated: false, user: null }
  }
  async function refresh() {
    try {
      const value = await $fetch<AuthStatus>('/api/auth/status', { timeout: 10000 })
      if (marker() && value.enabled) {
        if (value.authenticated)
          try {
            await $fetch('/api/auth/logout', { method: 'POST', timeout: 5000 })
          } catch {}
        state.value = { ...value, authenticated: false, user: null }
      } else {
        if (!value.enabled) marker(false)
        state.value = value
      }
      error.value = ''
    } catch (e: any) {
      if (marker()) invalidate()
      error.value = e.data?.message || 'Не удалось подключиться к серверу'
    } finally {
      loaded.value = true
    }
    return state.value
  }
  async function login(username: string, password: string, deviceName: string) {
    pending.value = true
    error.value = ''
    try {
      await $fetch('/api/auth/login', {
        method: 'POST',
        body: { username, password, deviceName },
        timeout: 15000,
      })
      marker(false)
      await refresh()
      if (!state.value.authenticated) throw new Error('Вход не завершён')
      await useWorkspace().refresh()
      await navigateTo('/')
    } catch (e: any) {
      error.value = e.data?.message || e.message || 'Не удалось войти'
    } finally {
      pending.value = false
    }
  }
  async function logout() {
    pending.value = true
    marker(true)
    error.value = ''
    try {
      if (state.value.enabled) await $fetch('/api/auth/logout', { method: 'POST', timeout: 5000 })
    } catch (e: any) {
      if (e.statusCode !== 401)
        error.value = 'Вы вышли на этом устройстве. Завершим серверную сессию при подключении.'
    } finally {
      useWorkspace().clear()
      invalidate()
      pending.value = false
      await navigateTo('/login')
    }
  }
  return { state, loaded, error, pending, refresh, login, logout, invalidate }
}
