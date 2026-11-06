<script setup lang="ts">
import { ru } from '@nuxt/ui/locale'
const { refresh, toast, pending } = useWorkspace()
async function refreshVisible() {
  if (!document.hidden && !pending.value) {
    const auth = useAuth()
    await auth.refresh()
    if (auth.state.value.authenticated) await refresh()
    else if (auth.state.value.enabled) await navigateTo('/login')
  }
}
onMounted(async () => {
  const auth = useAuth()
  await auth.refresh()
  if (auth.state.value.authenticated) await refresh()
  window.addEventListener('focus', refreshVisible)
  document.addEventListener('visibilitychange', refreshVisible)
})
onUnmounted(() => {
  window.removeEventListener('focus', refreshVisible)
  document.removeEventListener('visibilitychange', refreshVisible)
})
</script>
<template>
  <UApp :locale="ru"
    ><NuxtLayout><NuxtPage /></NuxtLayout
    ><Transition name="toast"
      ><div v-if="toast" class="toast" role="status">
        <AppIcon name="done" :size="19" />{{ toast }}
      </div></Transition
    ></UApp
  >
</template>
