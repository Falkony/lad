<script setup lang="ts">
import { money, sumAmounts, localDate } from '../../shared/money'
import { categories } from '../../shared/types'
const { workspace: w, command, pending } = useWorkspace()
const route = useRoute()
const linkedTransaction = ref('')
const view = ref('active'),
  selected = ref<string[]>([]),
  bulkCategory = ref('Продукты')
const operationOpen = ref(false),
  importOpen = ref(false),
  search = ref(''),
  kind = ref('all'),
  category = ref('all'),
  accountId = ref('all'),
  month = ref(localDate().slice(0, 7)),
  page = ref(1)
const filtered = computed(() =>
  (view.value === 'deleted' ? w.value.deletedTransactions : w.value.transactions).filter(
    (t) =>
      (!month.value || t.date.startsWith(month.value)) &&
      (!linkedTransaction.value || t.id === linkedTransaction.value) &&
      (kind.value === 'all' || t.kind === kind.value) &&
      (category.value === 'all' || t.category === category.value) &&
      (accountId.value === 'all' ||
        t.accountId === accountId.value ||
        t.toAccountId === accountId.value) &&
      `${t.description} ${t.category}`
        .toLocaleLowerCase('ru')
        .includes(search.value.toLocaleLowerCase('ru')),
  ),
)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 20)))
watch([search, kind, category, accountId, month, view], () => {
  page.value = 1
  selected.value = []
})
watch(
  () => route.query.account,
  (value) => {
    if (typeof value === 'string') {
      accountId.value = value
      month.value = ''
      view.value = 'active'
    } else {
      accountId.value = 'all'
    }
  },
  { immediate: true },
)
const visible = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20))
watch(
  () => route.query.transaction,
  (value) => {
    linkedTransaction.value = typeof value === 'string' ? value : ''
    if (linkedTransaction.value) {
      view.value = 'active'
      month.value = ''
      accountId.value = 'all'
      category.value = 'all'
      kind.value = 'all'
      search.value = ''
    }
  },
  { immediate: true },
)
function clearLinkedTransaction() {
  linkedTransaction.value = ''
  navigateTo('/transactions')
}
watch(
  () => w.value.transactions,
  (rows) => {
    const valid = new Set(
      rows.filter((t) => ['expense', 'income'].includes(t.kind)).map((t) => t.id),
    )
    selected.value = selected.value.filter((id) => valid.has(id))
  },
)
function selectPage() {
  const ids = visible.value.filter((t) => ['income', 'expense'].includes(t.kind)).map((t) => t.id)
  selected.value = ids.every((id) => selected.value.includes(id))
    ? selected.value.filter((id) => !ids.includes(id))
    : [...new Set([...selected.value, ...ids])]
}
async function categorize() {
  try {
    await command(
      { op: 'transactions.categorize', ids: selected.value, category: bulkCategory.value },
      'Категория выбранных операций изменена',
    )
    selected.value = []
  } catch {}
}
watch(pageCount, (value) => {
  page.value = Math.min(page.value, value)
})
const income = computed(() =>
  sumAmounts(filtered.value.filter((t) => t.kind === 'income').map((t) => t.amount)),
)
const expense = computed(() =>
  sumAmounts(filtered.value.filter((t) => t.kind === 'expense').map((t) => t.amount)),
)
const availableCategories = computed(() => [
  ...new Set([
    ...categories,
    ...w.value.transactions.map((t) => t.category),
    ...w.value.deletedTransactions.map((t) => t.category),
  ]),
])
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">КАЖДАЯ МЕЛОЧЬ ИМЕЕТ ЗНАЧЕНИЕ</div>
      <h1>История денег<span class="title-dot">.</span></h1>
      <p>Доходы, расходы и переводы — всё на своих местах.</p>
    </div>
    <div class="heading-actions">
      <button class="button secondary" @click="importOpen = true">
        <AppIcon name="upload" :size="17" />Импорт CSV</button
      ><button class="button primary" @click="operationOpen = true">
        <AppIcon name="plus" :size="18" />Операция
      </button>
    </div>
  </div>
  <div class="account-tabs">
    <button :class="{ selected: view === 'active' }" @click="view = 'active'">
      Операции · {{ w.transactions.length }}</button
    ><button :class="{ selected: view === 'deleted' }" @click="view = 'deleted'">
      Удалённые · {{ w.deletedTransactions.length }}
    </button>
  </div>
  <div v-if="view === 'active'" class="summary-strip">
    <div>
      <span>Доходы по фильтру</span><strong class="text-green">+{{ money(income) }}</strong>
    </div>
    <div>
      <span>Расходы по фильтру</span><strong>−{{ money(expense) }}</strong>
    </div>
    <div>
      <span>Всего операций</span><strong>{{ filtered.length }}</strong>
    </div>
  </div>
  <section class="panel operations-panel">
    <div v-if="linkedTransaction" class="linked-transaction-notice">
      <span>Связанный расход из календаря</span
      ><button class="text-button" @click="clearLinkedTransaction">
        Показать все операции <AppIcon name="close" :size="13" />
      </button>
    </div>
    <div class="filters">
      <label class="search-input"
        ><AppIcon name="search" :size="18" /><input
          v-model="search"
          placeholder="Поиск по операциям"
          aria-label="Поиск по операциям" /></label
      ><input v-model="month" type="month" aria-label="Месяц операций" /><select
        v-model="kind"
        aria-label="Тип операции"
      >
        <option value="all">Все типы</option>
        <option value="expense">Расходы</option>
        <option value="income">Доходы</option>
        <option value="transfer">Переводы</option>
        <option value="adjustment">Корректировки сверки</option></select
      ><button class="button secondary small-button" @click="month = ''">Все даты</button
      ><select aria-label="Категория" v-model="category">
        <option value="all">Все категории</option>
        <option v-for="cat in availableCategories" :key="cat">{{ cat }}</option></select
      ><select v-model="accountId" aria-label="Счёт">
        <option value="all">Все счета</option>
        <option v-for="a in w.accounts" :key="a.id" :value="a.id">
          {{ a.name }}{{ a.archived ? ' (архив)' : '' }}
        </option>
      </select>
    </div>
    <div v-if="view === 'active' && filtered.length" class="bulk-toolbar">
      <button class="text-button" @click="selectPage">Выбрать / снять страницу</button
      ><template v-if="selected.length"
        ><span>Выбрано: {{ selected.length }}</span
        ><select v-model="bulkCategory" aria-label="Категория выбранных операций">
          <option
            v-for="cat in availableCategories.filter(
              (c) => !['Перевод', 'Корректировка'].includes(c),
            )"
            :key="cat"
          >
            {{ cat }}
          </option></select
        ><button class="button secondary small-button" :disabled="pending" @click="categorize">
          Изменить категорию
        </button></template
      >
    </div>
    <p v-if="view === 'deleted'" class="trash-notice">
      Удалённые операции не меняют баланс и аналитику. Восстановление вернёт их в учёт.
    </p>
    <TransactionList
      v-model:selected="selected"
      :transactions="visible"
      :selectable="view === 'active'"
      deletable
    />
    <div class="pagination">
      <span>{{ filtered.length }} операций</span>
      <div>
        <button
          class="icon-button"
          :disabled="page === 1"
          aria-label="Предыдущая страница"
          @click="page--"
        >
          <AppIcon name="left" :size="17" /></button
        ><span>{{ page }} / {{ pageCount }}</span
        ><button
          class="icon-button"
          :disabled="page >= pageCount"
          aria-label="Следующая страница"
          @click="page++"
        >
          <AppIcon name="right" :size="17" />
        </button>
      </div>
    </div>
  </section>
  <div class="note-card">
    <AppIcon name="transfer" :size="21" />
    <p>
      Переводы и корректировки сверки меняют остатки, но не учитываются в доходах и расходах.
      Редактирование перевода пересчитывает оба счёта.
    </p>
  </div>
  <AppDialog
    v-model="operationOpen"
    title="Новая операция"
    description="Добавьте немного ясности в свой день."
    ><TransactionForm @saved="operationOpen = false" /></AppDialog
  ><AppDialog
    v-model="importOpen"
    title="Импорт банковской выписки"
    description="Сначала проверка, затем сохранение."
    ><ImportForm @saved="importOpen = false"
  /></AppDialog>
</template>
