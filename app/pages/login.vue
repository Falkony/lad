<script setup lang="ts">
definePageMeta({ layout: false })
const auth = useAuth(),
  username = ref(''),
  password = ref(''),
  deviceName = ref('')
async function submit() {
  await auth.login(username.value, password.value, deviceName.value)
  password.value = ''
}
</script>
<template>
  <main class="page-content">
    <section class="panel form-stack" style="max-width: 440px; margin: 10vh auto">
      <h1>Войти в Лад<span class="title-dot">.</span></h1>
      <p>Ваши деньги и дела на всех устройствах.</p>
      <form class="form-stack" @submit.prevent="submit">
        <label
          >Имя пользователя<input
            v-model="username"
            autocomplete="username"
            required
            maxlength="64"
            autocapitalize="none" /></label
        ><label
          >Пароль<input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            maxlength="256" /></label
        ><label
          >Название устройства<input
            v-model="deviceName"
            maxlength="80"
            placeholder="Например, мой телефон"
        /></label>
        <p v-if="auth.error.value" class="form-error" role="alert">{{ auth.error.value }}</p>
        <button class="button primary" :disabled="auth.pending.value">
          {{ auth.pending.value ? 'Входим…' : 'Войти' }}
        </button>
      </form>
    </section>
  </main>
</template>
