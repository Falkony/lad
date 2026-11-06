<script setup lang="ts">
const route = useRoute()
// The system theme by default; the header button stores an explicit choice on this device.
const colorMode = useColorMode()
const dark = computed(() => colorMode.value === 'dark')
function toggleTheme() {
  colorMode.preference = dark.value ? 'light' : 'dark'
}
const { workspace, command, notify, error, refresh } = useWorkspace()
const { downloadBackup, exporting } = useBackup()
const menu = ref(false)
const isMobile = ref(false)
let media: MediaQueryList | undefined
const updateMedia = () => {
  isMobile.value = media?.matches || false
}
const closeOnEscape = (event: KeyboardEvent) => {
  if (event.key === 'Escape') menu.value = false
}
onMounted(() => {
  media = window.matchMedia('(max-width: 800px)')
  updateMedia()
  media.addEventListener('change', updateMedia)
  window.addEventListener('keydown', closeOnEscape)
})
onUnmounted(() => {
  media?.removeEventListener('change', updateMedia)
  window.removeEventListener('keydown', closeOnEscape)
})
const resetOpen = ref(false)
const confirmation = ref('')
const links = [
  { to: '/', label: 'Обзор', icon: 'dashboard' },
  { to: '/accounts', label: 'Счета', icon: 'card' },
  { to: '/transactions', label: 'Операции', icon: 'wallet' },
  { to: '/budgets', label: 'Бюджеты', icon: 'budget' },
  { to: '/plans', label: 'Поступления и платежи', icon: 'repeat' },
  { to: '/forecast', label: 'Прогноз', icon: 'forecast' },
  { to: '/goals', label: 'Цели и желания', icon: 'target' },
  { to: '/obligations', label: 'Кредиты и долги', icon: 'bank' },
  { to: '/calendar', label: 'Календарь', icon: 'calendar' },
  { to: '/shopping', label: 'Список покупок', icon: 'shopping' },
  { to: '/backups', label: 'Резервные копии', icon: 'file' },
]
/** The section of the page, nested pages included (/obligations/… is «Кредиты и долги»). */
const current = computed(() =>
  links.find((x) => (x.to === '/' ? route.path === '/' : route.path.startsWith(x.to))),
)
watch(
  () => route.path,
  () => {
    menu.value = false
  },
)
const populated = computed(() =>
  ['accounts', 'transactions', 'goals', 'events', 'shopping', 'obligations'].some(
    (key) => (workspace.value as any)[key].length,
  ),
)
async function loadDemo() {
  try {
    await command({ op: 'demo.load' }, 'Демо-пространство готово')
  } catch {}
}
async function reset() {
  try {
    await command(
      { op: 'workspace.reset', confirmation: confirmation.value },
      'Пространство очищено',
    )
    resetOpen.value = false
    confirmation.value = ''
  } catch {}
}
</script>
<template>
  <div class="app-shell">
    <button v-if="menu" class="sidebar-scrim" aria-label="Закрыть меню" @click="menu = false" />
    <aside class="sidebar" :class="{ 'is-open': menu }" :inert="isMobile && !menu">
      <NuxtLink to="/" class="brand" aria-label="Лад — на главную"
        ><span class="brand-mark"
          ><svg viewBox="0 0 32 32">
            <path d="m5 25 9-18h5l9 18h-8l-4-9-4 9Z" fill="currentColor" />
            <circle cx="26" cy="7" r="3" fill="#e4bd75" /></svg></span
        ><span>лад<span class="brand-dot">.</span></span></NuxtLink
      >
      <div class="workspace-label">
        <span class="workspace-avatar"><AppIcon name="sprout" :size="18" /></span>
        <div><strong>Моё пространство</strong><span>Деньги и повседневность</span></div>
        <AppIcon name="down" :size="15" />
      </div>
      <div class="nav-caption">ЛИЧНОЕ</div>
      <nav aria-label="Основная навигация">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          :class="['nav-link', { active: link === current }]"
          ><AppIcon :name="link.icon" :size="19" /><span>{{ link.label }}</span
          ><span
            v-if="link.to === '/shopping' && workspace.shopping.filter((x) => !x.checked).length"
            class="nav-count"
            >{{ workspace.shopping.filter((x) => !x.checked).length }}</span
          ></NuxtLink
        >
      </nav>
      <div class="sidebar-bottom">
        <div class="quiet-card">
          <span class="tiny-leaf">✳</span><strong>Всё начинается с ясности</strong>
          <p>Маленькие шаги сегодня —<br />больше свободы завтра.</p>
          <span class="quiet-line" />
        </div>
        <button class="sidebar-action" :disabled="exporting" @click="downloadBackup">
          <AppIcon name="download" :size="18" />Экспорт данных
        </button>
        <button v-if="populated" class="sidebar-action" @click="resetOpen = true">
          <AppIcon name="settings" :size="18" />Очистить пространство
        </button>
        <div class="profile">
          <div class="profile-avatar">Я</div>
          <div>
            <strong>Личное пространство</strong><span><i />Данные на этом компьютере</span>
          </div>
        </div>
      </div>
    </aside>
    <main class="main-shell">
      <header class="topbar">
        <div class="breadcrumb">
          <button class="icon-button mobile-menu" aria-label="Открыть меню" @click="menu = true">
            <AppIcon name="menu" /></button
          ><span>Моё пространство</span><span class="breadcrumb-divider">/</span
          ><strong>{{ current?.label || 'Лад' }}</strong>
        </div>
        <div class="topbar-actions">
          <span class="local-indicator"><i />Локальная версия</span
          ><button v-if="!populated" class="demo-button" @click="loadDemo">
            <AppIcon name="sparkles" :size="15" />Открыть демо</button
          ><span v-else-if="workspace.isDemo" class="demo-badge">Демо-данные</span
          ><button
            class="icon-button theme-toggle"
            :aria-label="dark ? 'Включить светлую тему' : 'Включить тёмную тему'"
            :title="dark ? 'Светлая тема' : 'Тёмная тема'"
            @click="toggleTheme"
          >
            <AppIcon :name="dark ? 'sun' : 'moon'" :size="18" /></button
          ><NuxtLink
            to="/calendar"
            class="icon-button notifications"
            aria-label="Открыть календарь и напоминания"
            ><AppIcon name="bell" :size="19" /><i
              v-if="workspace.events.some((x) => !x.done)" /></NuxtLink
          ><span class="topbar-avatar">Я</span>
        </div>
      </header>
      <div v-if="workspace.isDemo" class="demo-strip">
        Вы смотрите пример с вымышленными данными.<button @click="resetOpen = true">
          Начать свой учёт <AppIcon name="arrow" :size="13" />
        </button>
      </div>
      <div class="page-content">
        <div v-if="error" class="error-banner" role="alert">
          {{ error }}<button @click="refresh">Повторить</button>
        </div>
        <slot />
      </div>
      <footer class="page-footer">
        <span>лад. <span>Меньше суеты. Больше ясности.</span></span
        ><span>Сделано для спокойной жизни <AppIcon name="sprout" :size="14" /></span>
      </footer>
    </main>
    <AppDialog
      v-model="resetOpen"
      title="Очистить пространство"
      description="Все записи будут удалены с этого компьютера. Сначала сохраните JSON-экспорт, если данные нужны."
      ><form class="form-stack" @submit.prevent="reset">
        <label
          >Введите УДАЛИТЬ для подтверждения<input
            v-model="confirmation"
            autocomplete="off"
            placeholder="УДАЛИТЬ"
            required /></label
        ><button class="button danger" :disabled="confirmation !== 'УДАЛИТЬ'">
          Удалить все данные
        </button>
      </form></AppDialog
    >
  </div>
</template>
