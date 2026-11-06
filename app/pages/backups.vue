<script setup lang="ts">
import { backupMaxBytes, backupSchema, backupVersion, type Backup } from '../../shared/backup'
import type { AutomaticBackupStatus } from '../../shared/automatic-backups'
const { workspace: w, refresh, command, pending, loading, error: connectionError } = useWorkspace()
const { exporting, downloadBackup } = useBackup()
const {
  data: automatic,
  error: automaticError,
  status: automaticStatus,
  refresh: refreshAutomatic,
} = await useFetch<AutomaticBackupStatus>('/api/backups', {
  watch: [() => w.value.revision],
})
const backup = ref<Backup | null>(null),
  name = ref(''),
  error = ref(''),
  confirmation = ref(''),
  preparing = ref(false),
  previewRevision = ref('')
const stale = computed(() => !!backup.value && previewRevision.value !== w.value.revision)
const sections = [
  { key: 'accounts', label: 'Счета' },
  { key: 'transactions', label: 'Операции' },
  { key: 'deletedTransactions', label: 'Удалённые операции' },
  { key: 'goals', label: 'Цели' },
  { key: 'events', label: 'Записи календаря' },
  { key: 'shopping', label: 'Товары' },
  { key: 'obligations', label: 'Обязательства' },
  { key: 'obligationEntries', label: 'Погашения и сверки обязательств' },
  { key: 'budgets', label: 'Лимиты бюджета' },
  { key: 'plans', label: 'Планы поступлений и платежей' },
  { key: 'planVersions', label: 'История настроек планов' },
  { key: 'planOccurrences', label: 'Отметки дат планов' },
] as const
async function updatePreview() {
  await refresh()
  if (!connectionError.value) previewRevision.value = w.value.revision
}
async function prepareBackup(raw: unknown) {
  const result = backupSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]!
    throw new Error(
      `Копия не прошла проверку (${issue.path.join('.') || 'структура'}): ${issue.message}`,
    )
  }
  await updatePreview()
  if (connectionError.value)
    throw new Error('Не удалось получить текущее состояние. Повторите загрузку копии.')
  backup.value = result.data
}
async function chooseAutomatic(filename: string) {
  backup.value = null
  error.value = ''
  confirmation.value = ''
  name.value = filename
  preparing.value = true
  try {
    await prepareBackup(await $fetch(`/api/backups/${encodeURIComponent(filename)}`))
  } catch {
    error.value =
      'Не удалось открыть автоматическую копию. Обновите список или выберите другой файл.'
  } finally {
    preparing.value = false
  }
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  backup.value = null
  error.value = ''
  confirmation.value = ''
  name.value = file?.name || ''
  if (!file) return
  preparing.value = true
  try {
    if (file.size > backupMaxBytes) throw new Error('Копия должна быть не больше 25 МБ')
    const raw = JSON.parse((await file.text()).replace(/^\uFEFF/, ''))
    await prepareBackup(raw)
  } catch (e: any) {
    error.value =
      e instanceof SyntaxError
        ? 'Не удалось прочитать JSON. Файл повреждён или имеет другой формат.'
        : e.message
  } finally {
    preparing.value = false
  }
}
async function restore() {
  if (!backup.value || stale.value) return
  error.value = ''
  try {
    await command(
      {
        op: 'workspace.restore',
        backup: backup.value,
        expectedRevision: previewRevision.value,
        confirmation: confirmation.value,
      },
      'Пространство восстановлено из копии',
    )
    backup.value = null
    confirmation.value = ''
    name.value = ''
  } catch (e: any) {
    error.value = e.message
    await refresh()
  }
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ВАШИ ДАННЫЕ — В ВАШИХ РУКАХ</div>
      <h1>Резервные копии<span class="title-dot">.</span></h1>
      <p>Сохраните своё пространство или восстановите его из файла.</p>
    </div>
    <button class="button primary" :disabled="exporting || loading" @click="downloadBackup">
      <AppIcon name="download" :size="17" />{{
        exporting ? 'Готовим копию…' : 'Скачать текущую копию'
      }}
    </button>
  </div>
  <section class="panel automatic-backups" aria-labelledby="automatic-backups-title">
    <div class="panel-heading">
      <div>
        <h2 id="automatic-backups-title">Автоматические копии</h2>
        <p v-if="automatic">
          При запуске и перед заменой данных. Изменений между копиями: {{ automatic.every }}.
          Максимум копий: {{ automatic.keep }}.
        </p>
      </div>
      <button
        class="button secondary small-button"
        :disabled="automaticStatus === 'pending'"
        @click="refreshAutomatic()"
      >
        Обновить
      </button>
    </div>
    <div class="automatic-backups-body">
      <p v-if="automaticError" class="form-error" role="alert">
        Не удалось получить сведения об автоматических копиях. Попробуйте обновить список.
      </p>
      <p v-else-if="!automatic" class="form-hint" role="status">Проверяем автоматические копии…</p>
      <template v-if="automatic">
        <p v-if="automatic.error" class="form-error" role="alert">{{ automatic.error }}</p>
        <p v-if="automatic.files[0]" class="automatic-backups-latest">
          Последняя копия:
          <strong>{{ new Date(automatic.files[0].createdAt).toLocaleString('ru-RU') }}</strong>
        </p>
        <p v-else class="form-hint">Сохранённых автоматических копий пока нет.</p>
        <p class="automatic-backups-path">Папка на сервере: {{ automatic.directory }}</p>
        <details v-if="automatic.files.length">
          <summary>Сохранённые копии ({{ automatic.files.length }})</summary>
          <ul class="automatic-backups-list">
            <li v-for="file in automatic.files" :key="file.name">
              <time :datetime="file.createdAt">{{
                new Date(file.createdAt).toLocaleString('ru-RU')
              }}</time>
              <div class="automatic-backups-actions">
                <a
                  :href="`/api/backups/${encodeURIComponent(file.name)}`"
                  download
                  class="button secondary small-button"
                  >Скачать</a
                >
                <button
                  class="button secondary small-button"
                  :disabled="pending || preparing"
                  @click="chooseAutomatic(file.name)"
                >
                  Подготовить восстановление
                </button>
              </div>
            </li>
          </ul>
        </details>
      </template>
    </div>
  </section>
  <div class="backup-layout">
    <section class="panel backup-upload">
      <div class="panel-heading">
        <div>
          <h2>Восстановление из JSON</h2>
          <p>Поддерживаются копии версий 1–{{ backupVersion }}</p>
        </div>
        <AppIcon name="restore" />
      </div>
      <div class="backup-body">
        <label class="file-drop"
          ><AppIcon name="upload" :size="28" /><strong>{{
            name || 'Выберите резервную копию'
          }}</strong
          ><span>JSON · до 25 МБ</span
          ><input
            type="file"
            accept=".json,application/json"
            :disabled="pending || preparing"
            @change="choose"
        /></label>
        <p v-if="preparing" class="form-hint" role="status">
          Проверяем структуру, суммы и связи между записями…
        </p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <template v-if="backup"
          ><div class="backup-file-meta">
            <strong>Копия проверена</strong
            ><span
              >{{ new Date(backup.exportedAt).toLocaleString('ru-RU') }} · версия {{ backup.version
              }}{{ backup.isDemo ? ' · демо-данные' : '' }}</span
            >
          </div>
          <table class="backup-preview-table">
            <thead>
              <tr>
                <th>Раздел</th>
                <th>Сейчас</th>
                <th>В копии</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="section in sections" :key="section.key">
                <td>{{ section.label }}</td>
                <td>{{ w[section.key].length }}</td>
                <td>{{ backup[section.key].length }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="stale" class="backup-stale" role="alert">
            <p>
              После предпросмотра пространство изменилось. Проверьте обновлённые количества перед
              восстановлением.
            </p>
            <button
              class="button secondary small-button"
              :disabled="loading"
              @click="updatePreview"
            >
              Обновить предпросмотр
            </button>
          </div>
          <form class="form-stack" @submit.prevent="restore">
            <p class="restore-notice">
              Восстановление полностью заменит текущие записи содержимым копии, включая архив счетов
              и удалённые операции. При ошибке текущее пространство сохранится целиком.
            </p>
            <label
              >Введите ВОССТАНОВИТЬ для подтверждения<input
                v-model="confirmation"
                placeholder="ВОССТАНОВИТЬ"
                autocomplete="off"
                required /></label
            ><button
              class="button primary full"
              :disabled="pending || stale || loading || confirmation !== 'ВОССТАНОВИТЬ'"
            >
              {{ pending ? 'Восстанавливаем…' : 'Заменить пространство данными копии' }}
            </button>
          </form></template
        >
      </div>
    </section>
    <aside class="backup-explanation">
      <AppIcon name="file" :size="31" />
      <h2>Что сохраняется в копии</h2>
      <p>
        Счета и их начальные остатки, операции и корректировки, импортные идентификаторы, цели,
        обязательства и история погашений, календарь, список покупок, бюджеты, планы, их версии и
        отметки дат.
      </p>
      <p>
        Копия содержит финансовые данные в обычном JSON-файле. Храните её там, где вам удобно
        защищать личные документы.
      </p>
      <p>
        Перед восстановлением можно скачать текущее пространство кнопкой сверху. Копии не
        объединяются — выбранный файл заменяет записи целиком.
      </p>
    </aside>
  </div>
</template>
