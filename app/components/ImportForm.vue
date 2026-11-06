<script setup lang="ts">
import Papa from 'papaparse'
import { previewImport, type ImportMapping, type ImportPreview } from '../../shared/import'
import type { ImportSuggestion, ImportDecision } from '../../shared/import-workflow'
import { money } from '../../shared/money'
const emit = defineEmits<{ saved: [] }>()
const { workspace, command, pending, notify } = useWorkspace()
const rows = ref<Record<string, string>[]>([]),
  headers = ref<string[]>([]),
  fileName = ref(''),
  error = ref(''),
  accountId = ref(workspace.value.accounts.find((a) => !a.archived)?.id || ''),
  busy = ref(false)
const preview = ref<ImportPreview | null>(null)
const suggestions = ref<ImportSuggestion[]>([]),
  labels = ref<Record<string, string>>({}),
  choices = ref<Record<number, string>>({}),
  revision = ref(''),
  templateName = ref('')
const mapping = reactive<ImportMapping>({
  date: '',
  amount: '',
  description: '',
  category: '',
  externalId: '',
  mode: 'signed',
})
const skipped = computed(() => suggestions.value.filter((s) => s.duplicate).length)
watch([mapping, accountId], () => {
  preview.value = null
})
async function fileChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = ''
  preview.value = null
  if (file.size > 5 * 1024 * 1024) {
    error.value = 'Размер CSV не должен превышать 5 МБ'
    return
  }
  const text = await file.text()
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.replace(/^\uFEFF/, '').trim(),
  })
  if (result.errors.length) {
    error.value = 'Не удалось прочитать CSV. Проверьте структуру и кодировку UTF-8.'
    return
  }
  if (result.data.length > 2000) {
    error.value = 'За один раз можно загрузить до 2 000 операций'
    return
  }
  rows.value = result.data
  headers.value = result.meta.fields || []
  fileName.value = file.name
  const find = (pattern: RegExp) => headers.value.find((h) => pattern.test(h)) || ''
  mapping.date = find(/^дата$|^date$|дата операции/i)
  mapping.amount = find(/^сумма$|^amount$|сумма операции/i)
  mapping.description = find(/описание|description|назначение/i)
  mapping.category = find(/категория|category/i)
  mapping.externalId = find(/^id$|идентификатор/i)
}
async function prepare() {
  busy.value = true
  error.value = ''
  try {
    const local = await previewImport(rows.value, mapping, accountId.value)
    preview.value = local
    choices.value = {}
    suggestions.value = []
    if (!local.errors.length && local.rows.length) {
      const server = await $fetch('/api/import/preview', {
        method: 'POST',
        body: { transactions: local.rows, fileName: fileName.value },
      })
      preview.value = { ...local, rows: server.rows as ImportPreview['rows'] }
      suggestions.value = server.suggestions
      labels.value = server.labels
      revision.value = server.revision
    }
  } catch {
    preview.value = null
    error.value = 'Не удалось подготовить импорт'
  } finally {
    busy.value = false
  }
}
async function save() {
  if (!preview.value || preview.value.errors.length) return
  try {
    const decisions: ImportDecision[] = Object.entries(choices.value)
      .filter(([, value]) => typeof value === 'string' && value)
      .map(([index, value]) => {
        const [action, id, dueDate] = value.split(':')
        return {
          index: Number(index),
          action: action as ImportDecision['action'],
          ...(action === 'match'
            ? { transactionId: id }
            : action === 'plan'
              ? { planId: id, dueDate }
              : action === 'transfer'
                ? { toAccountId: id }
                : {}),
        }
      })
    const result = await command({
      op: 'import',
      expectedRevision: revision.value,
      data: { transactions: preview.value.rows, fileName: fileName.value, decisions },
    })
    notify(
      `Добавлено: ${result.imported}. Связано: ${result.matched || 0}. Пропущено: ${result.skipped}.`,
    )
    emit('saved')
  } catch (e: any) {
    error.value = e.message
  }
}
async function saveTemplate() {
  try {
    await command(
      { op: 'import.template.save', name: templateName.value, mapping: { ...mapping } },
      'Шаблон сохранён',
    )
    preview.value = null
  } catch (e: any) {
    error.value = e.message
  }
}
function applyTemplate(id: string) {
  const template = workspace.value.importTemplates?.find((t) => t.id === id)
  if (template) Object.assign(mapping, template.mapping)
}
</script>
<template>
  <div class="form-stack">
    <div class="import-info">
      <AppIcon name="file" :size="23" />
      <p>
        CSV в UTF-8 с колонками даты и суммы. Выберите, какие колонки использовать. XLSX и PDF
        появятся позже.
      </p>
    </div>
    <label class="file-drop"
      ><AppIcon name="upload" :size="26" /><strong>{{ fileName || 'Выберите CSV-выписку' }}</strong
      ><span>До 5 МБ · максимум 2 000 операций</span
      ><input type="file" accept=".csv,text/csv" @change="fileChange"
    /></label>
    <label v-if="workspace.importTemplates?.length"
      >Шаблон колонок<select @change="applyTemplate(($event.target as HTMLSelectElement).value)">
        <option value="">Выберите</option>
        <option v-for="t in workspace.importTemplates" :key="t.id" :value="t.id">
          {{ t.name }}
        </option>
      </select></label
    >
    <template v-if="headers.length"
      ><label
        >Счёт<select v-model="accountId" required>
          <option value="" disabled>Выберите счёт</option>
          <option
            v-for="account in workspace.accounts.filter((a) => !a.archived)"
            :key="account.id"
            :value="account.id"
          >
            {{ account.name }}
          </option>
        </select></label
      >
      <div class="form-row">
        <label
          >Колонка даты<select v-model="mapping.date">
            <option value="" disabled>Выберите колонку</option>
            <option v-for="h in headers" :key="h">{{ h }}</option>
          </select></label
        ><label
          >Колонка суммы<select v-model="mapping.amount">
            <option value="" disabled>Выберите колонку</option>
            <option v-for="h in headers" :key="h">{{ h }}</option>
          </select></label
        >
      </div>
      <div class="form-row">
        <label
          >Описание<select v-model="mapping.description">
            <option value="">Не использовать</option>
            <option v-for="h in headers" :key="h">{{ h }}</option>
          </select></label
        ><label
          >Категория<select v-model="mapping.category">
            <option value="">Другое</option>
            <option v-for="h in headers" :key="h">{{ h }}</option>
          </select></label
        >
      </div>
      <label
        >ID операции банка<select v-model="mapping.externalId">
          <option value="">Нет в выписке</option>
          <option v-for="h in headers" :key="h">{{ h }}</option>
        </select></label
      ><label
        >Как читать суммы<select v-model="mapping.mode">
          <option value="signed">Минус — расход, плюс — доход</option>
          <option value="expense">Все строки — расходы</option>
          <option value="income">Все строки — доходы</option>
        </select></label
      >
      <p class="form-hint">
        В предпросмотре выберите совпадение, дату плана или второй счёт перевода. Без банковского ID
        совпадения определяются по дате, типу, сумме, описанию и номеру повтора; проверьте
        пересекающиеся выписки.
      </p>
      <button
        v-if="!preview"
        class="button secondary full"
        :disabled="!mapping.date || !mapping.amount || !accountId || busy"
        @click="prepare"
      >
        {{ busy ? 'Проверяем…' : 'Проверить перед импортом' }}
      </button></template
    >
    <div v-if="preview" class="import-preview">
      <div class="inline-heading">
        <strong>Предпросмотр · {{ preview.rows.length }} операций</strong
        ><button class="text-button" @click="preview = null">Изменить</button>
      </div>
      <p class="form-hint">
        Из них уже загружено: {{ skipped }}. Совпадения предлагаются по дате и сумме; проверьте
        описание. Автоматического объединения нет.
      </p>
      <details>
        <summary>
          Решения по строкам · {{ suggestions.filter((s) => s.ambiguous).length }} неоднозначных
        </summary>
        <div v-for="suggestion in suggestions" :key="suggestion.index" class="form-stack">
          <p>
            {{ suggestion.index + 1 }} · {{ preview.rows[suggestion.index]?.date }} ·
            {{ preview.rows[suggestion.index]?.description }} ·
            {{ money(preview.rows[suggestion.index]?.amount || '0') }}
          </p>
          <p v-if="suggestion.duplicate">Уже загружено — будет пропущено</p>
          <label v-else
            >Применить как<select v-model="choices[suggestion.index]">
              <option :value="undefined">Новую операцию</option>
              <option value="new">Новую операцию</option>
              <option value="ignore">Пропустить</option>
              <option
                v-for="id in [...suggestion.manualIds, ...suggestion.transferIds]"
                :key="id"
                :value="'match:' + id"
              >
                Связать: {{ labels[id] }}
              </option>
              <option
                v-for="p in suggestion.plans"
                :key="p.planId + ':' + p.dueDate"
                :value="'plan:' + p.planId + ':' + p.dueDate"
              >
                План: {{ p.title }} · {{ p.dueDate }}
              </option>
              <option
                v-for="a in workspace.accounts.filter((a) => !a.archived && a.id !== accountId)"
                :key="a.id"
                :value="'transfer:' + a.id"
              >
                Перевод между своими счетами: {{ a.name }}
              </option>
            </select></label
          >
        </div>
      </details>
      <div class="form-row">
        <label>Название шаблона<input v-model="templateName" maxlength="160" /></label
        ><button
          type="button"
          class="button secondary"
          :disabled="!templateName || pending"
          @click="saveTemplate"
        >
          Сохранить колонки
        </button>
      </div>
      <div v-for="(row, index) in preview.rows.slice(0, 5)" :key="index" class="import-preview-row">
        <span
          >{{ row.date }}<small>{{ row.description || row.category }}</small></span
        ><strong>{{ row.kind === 'expense' ? '−' : '+' }}{{ money(row.amount) }}</strong>
      </div>
      <p v-if="preview.rows.length > 5" class="form-hint">
        И ещё {{ preview.rows.length - 5 }} операций
      </p>
      <p v-for="message in preview.errors.slice(0, 5)" :key="message" class="form-error">
        {{ message }}
      </p>
      <p v-if="preview.errors.length" class="form-hint">
        Исправьте ошибки в файле и загрузите его заново.
      </p>
      <button
        class="button primary full"
        :disabled="pending || !!preview.errors.length || !preview.rows.length"
        @click="save"
      >
        {{ pending ? 'Импортируем…' : 'Подтвердить импорт' }}
      </button>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="!workspace.accounts.some((a) => !a.archived)" class="form-hint">
      Сначала добавьте счёт в разделе «Обзор».
    </p>
  </div>
</template>
