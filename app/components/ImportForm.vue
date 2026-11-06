<script setup lang="ts">
import Papa from 'papaparse'
import { previewImport, type ImportMapping, type ImportPreview } from '../../shared/import'
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
const mapping = reactive<ImportMapping>({
  date: '',
  amount: '',
  description: '',
  category: '',
  externalId: '',
  mode: 'signed',
})
const skipped = computed(
  () =>
    preview.value?.rows.filter((row) =>
      [...workspace.value.transactions, ...workspace.value.deletedTransactions].some(
        (t) =>
          (t.importAccountId || t.accountId) === row.accountId && t.importKey === row.importKey,
      ),
    ).length || 0,
)
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
    preview.value = await previewImport(rows.value, mapping, accountId.value)
  } catch {
    error.value = 'Не удалось подготовить импорт'
  } finally {
    busy.value = false
  }
}
async function save() {
  if (!preview.value || preview.value.errors.length) return
  try {
    const result = await command({ op: 'import', data: { transactions: preview.value.rows } })
    notify(`Добавлено: ${result.imported}. Пропущено совпадений: ${result.skipped}.`)
    emit('saved')
  } catch (e: any) {
    error.value = e.message
  }
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
        Переводы между своими счетами пока нужно внести вручную. Без банковского ID совпадения
        определяются по дате, типу, сумме, описанию и номеру повтора; проверьте пересекающиеся
        выписки.
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
      <p class="form-hint">Из них уже загружено: {{ skipped }}</p>
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
