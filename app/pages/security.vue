<script setup lang="ts">
import type { DeviceSession } from '../../shared/auth'
const auth = useAuth(),
  currentPassword = ref(''),
  newPassword = ref(''),
  error = ref(''),
  message = ref(''),
  busy = ref(false)
const { data: sessions, refresh } = await useFetch<DeviceSession[]>('/api/auth/sessions', {
  immediate: auth.state.value.enabled,
  default: () => [],
})
async function revoke(id: string, current: boolean) {
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/revoke', { method: 'POST', body: { id } })
    if (current) {
      await auth.refresh()
      useWorkspace().clear()
      await navigateTo('/login')
    } else await refresh()
  } catch (e: any) {
    error.value = e.data?.message || 'Не удалось завершить сессию'
  } finally {
    busy.value = false
  }
}
async function changePassword() {
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
    })
    currentPassword.value = ''
    newPassword.value = ''
    message.value = 'Пароль изменён. Остальные устройства вышли из приложения.'
    await auth.refresh()
    await refresh()
  } catch (e: any) {
    error.value = e.data?.message || 'Не удалось изменить пароль'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>Доступ и устройства<span class="title-dot">.</span></h1>
      <p v-if="auth.state.value.user">{{ auth.state.value.user.username }} · личное пространство</p>
    </div>
    <button v-if="auth.state.value.enabled" class="button secondary" @click="auth.logout">
      Выйти на этом устройстве
    </button>
  </div>
  <p v-if="!auth.state.value.enabled" class="note-card">
    Включён локальный режим. Доступ с других устройств настраивается на сервере.
  </p>
  <template v-else
    ><p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <section class="panel form-stack">
      <h2>Активные устройства</h2>
      <article v-for="s in sessions" :key="s.id" class="inline-heading">
        <p>
          {{ s.deviceName }} ·
          {{ s.current ? 'это устройство' : new Date(s.createdAt).toLocaleString('ru-RU')
          }}<br /><small>До {{ new Date(s.expiresAt).toLocaleString('ru-RU') }}</small>
        </p>
        <button class="button secondary" :disabled="busy" @click="revoke(s.id, s.current)">
          Завершить сессию
        </button>
      </article>
    </section>
    <section class="panel form-stack">
      <h2>Изменить пароль</h2>
      <form class="form-stack" @submit.prevent="changePassword">
        <label
          >Текущий пароль<input
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            maxlength="256" /></label
        ><label
          >Новый пароль<input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            minlength="12"
            maxlength="256"
            required /></label
        ><button class="button primary" :disabled="busy">Изменить пароль</button>
      </form>
      <p class="form-hint">
        Минимум 12 символов. После изменения потребуется войти заново на остальных устройствах.
      </p>
    </section></template
  >
</template>
