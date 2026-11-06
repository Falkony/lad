<script setup lang="ts">
const { workspace: w, command, pending } = useWorkspace()
const page = ref(1),
  error = ref(''),
  rule = reactive({
    name: '',
    pattern: '',
    categoryId: '',
    accountId: null as string | null,
    kind: null as 'expense' | 'income' | null,
    priority: 100,
    enabled: true,
  })
const { data: batches, refresh } = await useFetch('/api/import/batches', {
  query: computed(() => ({ page: page.value, revision: w.value.revision })),
  default: () => [],
})
const undo = ref<{
  batch: { id: string; fileName: string }
  problems: string[]
  created: number
  matched: number
  revision: string
} | null>(null)
async function saveRule() {
  try {
    await command({ op: 'import.rule.save', data: { ...rule } }, 'Правило сохранено')
    rule.name = ''
    rule.pattern = ''
  } catch (e: any) {
    error.value = e.message
  }
}
async function previewUndo(id: string) {
  try {
    undo.value = await $fetch<NonNullable<typeof undo.value>>('/api/import/undo-preview', {
      query: { id },
    })
  } catch (e: any) {
    error.value = e.data?.message || 'Не удалось проверить пакет'
  }
}
async function applyUndo() {
  if (!undo.value) return
  try {
    await command(
      { op: 'import.undo', id: undo.value.batch.id, expectedRevision: undo.value.revision },
      'Пакет отменён',
    )
    undo.value = null
    await refresh()
  } catch (e: any) {
    error.value = e.message
  }
}
async function remove(op: string, id: string) {
  try {
    await command({ op, id }, 'Удалено')
  } catch (e: any) {
    error.value = e.message
  }
}
async function toggle(r: NonNullable<typeof w.value.importRules>[number]) {
  try {
    await command(
      { op: 'import.rule.save', id: r.id, data: { ...r, enabled: !r.enabled } },
      'Правило обновлено',
    )
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>Импорт и правила<span class="title-dot">.</span></h1>
      <p>Правила применяются по приоритету. Совпадение — подстрока описания без учёта регистра.</p>
    </div>
    <NuxtLink to="/transactions" class="button secondary">Загрузить выписку</NuxtLink>
  </div>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  <section class="panel form-stack">
    <h2>Новое правило категории</h2>
    <form class="form-stack" @submit.prevent="saveRule">
      <div class="form-row">
        <label>Название<input v-model="rule.name" required maxlength="160" /></label
        ><label>Описание содержит<input v-model="rule.pattern" required maxlength="160" /></label>
      </div>
      <div class="form-row">
        <label
          >Категория<select v-model="rule.categoryId" required>
            <option value="" disabled>Выберите</option>
            <option
              v-for="c in (w.categories || []).filter((c) => !c.archived)"
              :key="c.id"
              :value="c.id"
            >
              {{ c.name }}
            </option>
          </select></label
        ><label
          >Счёт<select v-model="rule.accountId">
            <option :value="null">Любой</option>
            <option v-for="a in w.accounts.filter((a) => !a.archived)" :key="a.id" :value="a.id">
              {{ a.name }}
            </option>
          </select></label
        ><label
          >Вид<select v-model="rule.kind">
            <option :value="null">Любой</option>
            <option value="expense">Расход</option>
            <option value="income">Доход</option>
          </select></label
        ><label
          >Приоритет<input v-model.number="rule.priority" type="number" min="0" max="999"
        /></label>
      </div>
      <button class="button primary" :disabled="pending">Сохранить</button>
    </form>
    <article v-for="r in w.importRules" :key="r.id" class="inline-heading">
      <p>
        {{ r.name }} · «{{ r.pattern }}» →
        {{ w.categories?.find((c) => c.id === r.categoryId)?.name }} · {{ r.priority }}
      </p>
      <div class="heading-actions">
        <button class="button ghost" :disabled="pending" @click="toggle(r)">
          {{ r.enabled ? 'Выключить' : 'Включить' }}</button
        ><button
          class="button ghost danger-text"
          :disabled="pending"
          @click="remove('import.rule.delete', r.id)"
        >
          Удалить
        </button>
      </div>
    </article>
  </section>
  <section class="panel form-stack">
    <h2>Шаблоны колонок</h2>
    <p class="form-hint">
      Создаются в предпросмотре CSV; сохраняются на сервере и входят в резервную копию.
    </p>
    <article v-for="t in w.importTemplates" :key="t.id" class="inline-heading">
      <p>{{ t.name }} · дата: {{ t.mapping.date }} · сумма: {{ t.mapping.amount }}</p>
      <button
        class="button ghost danger-text"
        :disabled="pending"
        @click="remove('import.template.delete', t.id)"
      >
        Удалить
      </button>
    </article>
  </section>
  <section class="panel form-stack">
    <h2>Пакеты импорта</h2>
    <article v-for="b in batches" :key="b.id" class="inline-heading">
      <div>
        <strong>{{ b.fileName || 'Выписка' }}</strong>
        <p>
          {{ new Date(b.createdAt).toLocaleString('ru-RU') }} ·
          {{ b.status === 'undone' ? 'Отменён' : 'Применён' }}
        </p>
        <p>
          Добавлено {{ b.report.imported }}, совпадений {{ b.report.matched }}, планов
          {{ b.report.linked }}, пропущено {{ b.report.skipped + b.report.ignored }}
        </p>
      </div>
      <button
        class="button secondary"
        :disabled="pending || b.status === 'undone'"
        @click="previewUndo(b.id)"
      >
        Проверить отмену
      </button>
    </article>
    <div class="pagination">
      <button class="button ghost" :disabled="page === 1" @click="page--">Назад</button
      ><span>{{ page }}</span
      ><button class="button ghost" :disabled="batches.length < 20" @click="page++">Далее</button>
    </div>
  </section>
  <AppDialog :model-value="!!undo" title="Отмена пакета" @update:model-value="undo = null"
    ><template v-if="undo"
      ><p>
        Созданных операций: {{ undo.created }}. Сопоставленных прежних операций: {{ undo.matched }}.
      </p>
      <p class="form-hint">
        Созданные записи перейдут в удалённые, ключи пакета освободятся для повторного импорта.
        Прежние сопоставленные операции сохранятся. Изменения и последующие связи блокируют отмену.
      </p>
      <p v-for="problem in undo.problems" :key="problem" class="form-error">{{ problem }}</p>
      <button
        class="button danger"
        :disabled="pending || !!undo.problems.length"
        @click="applyUndo"
      >
        Отменить пакет
      </button></template
    ></AppDialog
  >
</template>
