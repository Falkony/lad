<script setup lang="ts">
import { validTimeZone } from '../../shared/time-zone'
const { workspace: w, command, pending } = useWorkspace()
const name = ref(''),
  zone = ref(w.value.timeZone || 'Europe/Moscow'),
  error = ref(''),
  source = ref(''),
  target = ref('')
watch(
  () => w.value.timeZone,
  (value) => {
    zone.value = value || 'Europe/Moscow'
  },
)
const names = reactive<Record<string, string>>({})
const labels: Record<string, string> = {
  transactions: 'операции',
  deletedTransactions: 'удалённые операции',
  budgets: 'лимиты',
  plans: 'планы',
  planVersions: 'версии планов',
  planOccurrences: 'отметки дат',
}
const affected = computed(() =>
  [
    'transactions',
    'deletedTransactions',
    'budgets',
    'plans',
    'planVersions',
    'planOccurrences',
  ].map((key) => ({
    key,
    count: ((w.value as any)[key] as any[]).filter((row) => row.categoryId === source.value).length,
  })),
)
async function run(payload: Record<string, unknown>) {
  error.value = ''
  try {
    await command({ ...payload, expectedRevision: w.value.revision }, 'Настройки сохранены')
    return true
  } catch (e: any) {
    error.value = e.message
    return false
  }
}
async function createCategory() {
  if (await run({ op: 'category.create', name: name.value })) name.value = ''
}
async function mergeCategory() {
  if (await run({ op: 'category.merge', id: source.value, targetId: target.value }))
    source.value = ''
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ПРАВИЛА ВАШЕГО УЧЁТА</div>
      <h1>Настройки<span class="title-dot">.</span></h1>
      <p>Категории и часовой пояс пространства.</p>
    </div>
  </div>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <section class="panel history-panel">
    <h2>Часовой пояс</h2>
    <form class="form-stack" @submit.prevent="run({ op: 'settings.update', timeZone: zone })">
      <label>Часовой пояс IANA<input v-model="zone" list="time-zones" required /></label
      ><datalist id="time-zones">
        <option>Europe/Moscow</option>
        <option>Europe/Kaliningrad</option>
        <option>Asia/Yekaterinburg</option>
        <option>Asia/Novosibirsk</option>
        <option>Asia/Vladivostok</option>
        <option>UTC</option>
      </datalist>
      <p class="form-hint">
        Определяет «сегодня», границы месяцев и проверку будущих операций на всех устройствах.
      </p>
      <button class="button primary" :disabled="pending || !validTimeZone(zone)">
        Сохранить часовой пояс
      </button>
    </form>
  </section>
  <section class="panel history-panel">
    <h2>Категории</h2>
    <form class="form-stack" @submit.prevent="createCategory">
      <label>Новая категория<input v-model="name" maxlength="160" required /></label
      ><button class="button primary" :disabled="pending">Добавить</button>
    </form>
    <ul class="history-list">
      <li v-for="c in w.categories" :key="c.id">
        <div>
          <input
            :value="names[c.id] ?? c.name"
            :aria-label="`Название категории ${c.name}`"
            @input="names[c.id] = ($event.target as HTMLInputElement).value"
          /><span v-if="c.archived"> В архиве</span>
        </div>
        <div class="automatic-backups-actions">
          <button
            class="button secondary small-button"
            :disabled="pending || !names[c.id]?.trim() || names[c.id] === c.name"
            @click="run({ op: 'category.rename', id: c.id, name: names[c.id] })"
          >
            Переименовать</button
          ><button
            class="button secondary small-button"
            :disabled="pending"
            @click="run({ op: 'category.archive', id: c.id, archived: !c.archived })"
          >
            {{ c.archived ? 'Вернуть' : 'В архив' }}
          </button>
        </div>
      </li>
    </ul>
  </section>
  <section class="panel history-panel">
    <h2>Объединение категорий</h2>
    <form class="form-stack" @submit.prevent="mergeCategory">
      <label
        >Перенести записи из<select v-model="source" required>
          <option value="">Выберите категорию</option>
          <option v-for="c in w.categories" :value="c.id" :key="c.id">{{ c.name }}</option>
        </select></label
      >
      <label
        >В категорию<select v-model="target" required>
          <option value="">Выберите категорию</option>
          <option
            v-for="c in w.categories?.filter((c) => c.id !== source && !c.archived)"
            :value="c.id"
            :key="c.id"
          >
            {{ c.name }}
          </option>
        </select></label
      >
      <p v-if="source" class="restore-notice">
        Будут перенесены: {{ affected.map((a) => `${labels[a.key]}: ${a.count}`).join(', ') }}.
        Лимиты одного месяца складываются. Суммы операций сохраняются, исходная категория удаляется.
      </p>
      <button class="button danger" :disabled="pending || !source || !target || source === target">
        Объединить по этому предпросмотру
      </button>
    </form>
  </section>
</template>
