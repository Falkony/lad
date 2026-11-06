<script setup lang="ts">
import {
  commandLabels,
  type CommandHistoryEntry,
  type CommandHistoryPage,
} from '../../shared/command-history'

const { workspace } = useWorkspace()
const cursors = ref<(string | undefined)[]>([undefined])
const query = computed(() => ({ before: cursors.value.at(-1), limit: 20 }))
const { data, status, error, refresh } = await useFetch<CommandHistoryPage>('/api/history', {
  query,
})
watch(
  () => workspace.value.revision,
  () => {
    cursors.value = [undefined]
    refresh()
  },
)
function summary(entry: CommandHistoryEntry) {
  if (entry.operation === 'import')
    return `Добавлено: ${entry.result.imported ?? 0}; пропущено: ${entry.result.skipped ?? 0}`
  if (entry.operation === 'workspace.restore') return 'Данные и история заменены выбранной копией'
  if (entry.operation === 'workspace.reset') return 'Прежние данные и история очищены'
  const fields = entry.payload.data
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    for (const key of ['title', 'name', 'description', 'category'])
      if (typeof fields[key] === 'string' && fields[key]) return fields[key]
  }
  if (typeof entry.payload.category === 'string') return entry.payload.category
  if (entry.result.alreadyPaid) return 'Повторное подтверждение без новой операции'
  return ''
}
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ЧТО И КОГДА ИЗМЕНИЛОСЬ</div>
      <h1>История изменений<span class="title-dot">.</span></h1>
      <p>Успешно сохранённые действия, начиная с включения журнала.</p>
    </div>
    <button class="button secondary" :disabled="status === 'pending'" @click="refresh()">
      Обновить
    </button>
  </div>
  <p class="form-hint">
    Очистка удаляет прежнюю историю. Восстановление заменяет её историей из копии. Предыдущие данные
    остаются в предварительной автоматической копии.
  </p>
  <section class="panel history-panel" aria-label="Сохранённые изменения">
    <p v-if="error" class="form-error" role="alert">
      Не удалось загрузить историю. Попробуйте обновить.
    </p>
    <p v-else-if="status === 'pending'" class="form-hint" role="status">Загружаем историю…</p>
    <p v-else-if="!data?.entries.length" class="form-hint">
      История пока пуста. Следующее сохранённое действие появится здесь; прежние действия не
      восстанавливаются задним числом.
    </p>
    <ol v-else class="history-list">
      <li v-for="entry in data.entries" :key="entry.id">
        <div>
          <strong>{{ commandLabels[entry.operation] || 'Изменение данных' }}</strong>
          <p v-if="summary(entry)">{{ summary(entry) }}</p>
        </div>
        <div class="history-meta">
          <time :datetime="entry.createdAt">{{
            new Date(entry.createdAt).toLocaleString('ru-RU')
          }}</time>
          <span>Изменение №{{ entry.revision }}</span>
        </div>
      </li>
    </ol>
    <div class="history-pagination">
      <button
        class="button secondary small-button"
        :disabled="status === 'pending' || cursors.length === 1"
        @click="cursors.pop()"
      >
        К новым
      </button>
      <span>Страница {{ cursors.length }}</span>
      <button
        class="button secondary small-button"
        :disabled="status === 'pending' || !data?.nextBefore"
        @click="data?.nextBefore && cursors.push(data.nextBefore)"
      >
        К старым
      </button>
    </div>
  </section>
</template>
