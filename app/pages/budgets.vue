<script setup lang="ts">
import { categories } from '../../shared/types'
import { budgetRows, categorySpending, shiftMonth } from '../../shared/planning'
import { localDate, money, sumAmounts, toMinor, toMajor } from '../../shared/money'
import type { Budget } from '../../shared/planning-types'
import { monthSchema } from '../../shared/planning-schemas'
const { workspace: w, command, pending, notify } = useWorkspace()
const month = ref(localDate().slice(0, 7)),
  open = ref(false),
  editing = ref<Budget | null>(null),
  removing = ref<Budget | null>(null),
  error = ref('')
const form = reactive({ category: 'Продукты', limit: '' })
const route = useRoute()
watch(
  () => route.query.month,
  (value) => {
    if (monthSchema.safeParse(value).success) month.value = value as string
  },
  { immediate: true },
)
const rows = computed(() => budgetRows(w.value, month.value))
const totalLimit = computed(() => sumAmounts(rows.value.map((r) => r.limit))),
  totalSpent = computed(() => sumAmounts(rows.value.map((r) => r.spent)))
const options = computed(() => [
  ...new Set([
    ...categories.filter((c) => c !== 'Зарплата'),
    ...w.value.transactions.filter((t) => t.kind === 'expense').map((t) => t.category),
    ...w.value.recurringPayments.map((r) => r.category),
  ]),
])
const unbudgeted = computed(() =>
  [...categorySpending(w.value.transactions, month.value)]
    .filter(([category]) => !rows.value.some((row) => row.category === category))
    .sort((a, b) => (a[1] > b[1] ? -1 : 1)),
)
const label = computed(() =>
  new Date(month.value + '-01T12:00:00')
    .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
    .replace(' г.', ''),
)
function selectMonth(event: Event) {
  const input = event.target as HTMLInputElement
  if (monthSchema.safeParse(input.value).success) month.value = input.value
  else input.value = month.value
}
function edit(budget?: Budget, category?: string, amount?: string) {
  editing.value = budget || null
  form.category = budget?.category || category || 'Продукты'
  form.limit = budget ? toMajor(budget.limit) : amount ? toMajor(amount) : ''
  error.value = ''
  open.value = true
}
async function save() {
  error.value = ''
  try {
    await command(
      {
        op: 'budget.set',
        data: { month: month.value, category: form.category, limit: toMinor(form.limit) },
      },
      'Лимит сохранён',
    )
    open.value = false
  } catch (e: any) {
    error.value = e.message
  }
}
async function remove() {
  if (!removing.value) return
  try {
    await command({ op: 'budget.delete', id: removing.value.id }, 'Лимит удалён')
    removing.value = null
  } catch {}
}
async function copy() {
  try {
    const result = await command({
      op: 'budget.copy',
      from: shiftMonth(month.value, -1),
      to: month.value,
    })
    notify(
      result.copied
        ? `Лимитов перенесено: ${result.copied}. Существующие сохранены.`
        : 'В прошлом месяце нет новых лимитов для переноса',
    )
  } catch {}
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ПЛАН, КОТОРЫЙ ПОМОГАЕТ ВЫБИРАТЬ</div>
      <h1>Бюджет месяца<span class="title-dot">.</span></h1>
      <p>Лимиты по категориям, фактические траты и предстоящие платежи.</p>
    </div>
    <button class="button primary" @click="edit()">
      <AppIcon name="plus" :size="18" />Задать лимит
    </button>
  </div>
  <div class="section-toolbar planning-toolbar">
    <div class="period-control">
      <button
        class="icon-button"
        aria-label="Предыдущий месяц"
        @click="month = shiftMonth(month, -1)"
      >
        <AppIcon name="left" :size="16" /></button
      ><span>{{ label }}</span
      ><button
        class="icon-button"
        aria-label="Следующий месяц"
        @click="month = shiftMonth(month, 1)"
      >
        <AppIcon name="right" :size="16" />
      </button>
    </div>
    <div class="heading-actions">
      <input
        :value="month"
        type="month"
        required
        aria-label="Месяц бюджета"
        @change="selectMonth"
      /><button class="button secondary small-button" :disabled="pending" @click="copy">
        <AppIcon name="copy" :size="15" />Лимиты прошлого месяца
      </button>
    </div>
  </div>
  <div class="summary-strip">
    <div>
      <span>Всего лимитов</span><strong>{{ money(totalLimit) }}</strong>
    </div>
    <div>
      <span>Потрачено по бюджету</span><strong>{{ money(totalSpent) }}</strong>
    </div>
    <div>
      <span>Осталось по лимитам</span
      ><strong :class="{ 'budget-danger': BigInt(totalSpent) > BigInt(totalLimit) }">{{
        money((BigInt(totalLimit) - BigInt(totalSpent)).toString())
      }}</strong>
    </div>
  </div>
  <section class="panel budget-panel">
    <div class="panel-heading">
      <div>
        <h2>Категории · {{ rows.length }}</h2>
        <p>Предстоящие платежи — отдельно от уже записанных расходов</p>
      </div>
    </div>
    <article
      v-for="row in rows"
      :key="row.id"
      class="budget-row"
      :class="{
        over: BigInt(row.remaining) < 0n,
        warning: BigInt(row.remaining) >= 0n && BigInt(row.afterPlanned) < 0n,
      }"
    >
      <div class="budget-category-heading">
        <div>
          <h3>{{ row.category }}</h3>
          <span
            >{{ money(row.spent) }} <span class="muted">из {{ money(row.limit) }}</span></span
          >
        </div>
        <div class="budget-row-actions">
          <strong :class="{ 'budget-danger': BigInt(row.remaining) < 0n }"
            >{{ BigInt(row.remaining) < 0n ? 'Перерасход' : 'Осталось' }}
            {{
              money(
                BigInt(row.remaining) < 0n ? (-BigInt(row.remaining)).toString() : row.remaining,
              )
            }}</strong
          ><button
            class="icon-button"
            :aria-label="`Изменить лимит ${row.category}`"
            @click="edit(row)"
          >
            <AppIcon name="edit" :size="16" /></button
          ><button
            class="icon-button"
            :aria-label="`Удалить лимит ${row.category}`"
            @click="removing = row"
          >
            <AppIcon name="delete" :size="15" />
          </button>
        </div>
      </div>
      <div class="progress-bar"><span :style="{ width: `${row.percent}%` }" /></div>
      <div class="budget-row-foot">
        <span>{{ row.percent }}% лимита</span
        ><span v-if="BigInt(row.planned) > 0n"
          >Ещё повторяющихся платежей: {{ money(row.planned) }} · после них
          {{ money(row.afterPlanned) }}</span
        ><span v-else>Предстоящих платежей по расписаниям нет</span>
      </div>
    </article>
    <div v-if="!rows.length" class="empty-state large">
      <AppIcon name="budget" :size="34" /><strong>У месяца пока нет бюджета</strong>
      <p>Начните с продуктов, дома или транспорта.</p>
      <button class="button secondary" @click="edit()">Задать первый лимит</button>
    </div>
  </section>
  <section v-if="unbudgeted.length" class="panel unbudgeted-panel">
    <div class="panel-heading">
      <div>
        <h2>Расходы без лимита</h2>
        <p>Эти траты пока не входят в сводку бюджета</p>
      </div>
      <strong>{{ money(sumAmounts(unbudgeted.map(([, amount]) => amount.toString()))) }}</strong>
    </div>
    <div v-for="[category, amount] in unbudgeted" :key="category" class="unbudgeted-row">
      <span>{{ category }}</span
      ><strong>{{ money(amount) }}</strong
      ><button class="text-button" @click="edit(undefined, category, amount.toString())">
        Задать лимит <AppIcon name="plus" :size="13" />
      </button>
    </div>
  </section>
  <div class="note-card">
    <AppIcon name="calendar" :size="21" />
    <p>
      В факт попадают действующие расходы по дате операции. Переводы, сверки и удалённые записи
      исключены. Неоплаченные повторяющиеся платежи учитываются в прогнозе по месяцу срока оплаты.
    </p>
  </div>
  <AppDialog
    v-model="open"
    :title="editing ? 'Изменить лимит' : 'Новый лимит категории'"
    :description="label"
    ><form class="form-stack" @submit.prevent="save">
      <label
        >Категория<input
          v-model="form.category"
          list="budget-categories"
          required
          maxlength="160"
          :disabled="!!editing" /><datalist id="budget-categories">
          <option v-for="category in options" :key="category" :value="category" /></datalist></label
      ><label
        >Лимит на месяц, ₽<input
          v-model="form.limit"
          inputmode="decimal"
          class="amount-input"
          placeholder="0,00"
          required
      /></label>
      <p class="form-hint">
        Лимит действует только в выбранном месяце. Нулевой лимит означает, что траты по категории не
        запланированы.
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="button primary full" :disabled="pending">Сохранить лимит</button>
    </form></AppDialog
  >
  <AppDialog
    :model-value="!!removing"
    title="Удалить лимит?"
    :description="removing?.category"
    @update:model-value="removing = null"
    ><p class="form-hint">Операции и расходы сохранятся.</p>
    <div class="dialog-actions">
      <button class="button secondary" @click="removing = null">Отмена</button
      ><button class="button danger" :disabled="pending" @click="remove">Удалить лимит</button>
    </div></AppDialog
  >
</template>
