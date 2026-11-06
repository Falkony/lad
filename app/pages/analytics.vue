<script setup lang="ts">
import type { PeriodAnalysis } from '../../shared/periods'
import type { Account } from '../../shared/types'
import { localDate, money } from '../../shared/money'
import { shiftMonth } from '../../shared/planning'
const { workspace: w, command, pending } = useWorkspace()
const month = ref(shiftMonth(localDate().slice(0, 7), -1)),
  compare = ref(shiftMonth(month.value, -1)),
  note = ref(''),
  allowWarnings = ref(false),
  error = ref(''),
  reconciling = ref<Account | null>(null),
  selectedCategories = ref<string[]>([])
watch(month, (m) => {
  compare.value = shiftMonth(m, -1)
  note.value = ''
  allowWarnings.value = false
  selectedCategories.value = []
})
const {
  data: analysis,
  status,
  error: loadError,
  refresh,
} = await useFetch<PeriodAnalysis>('/api/analytics', {
  query: computed(() => ({
    month: month.value,
    compare: compare.value,
    revision: w.value.revision,
  })),
})
function selectPeriod(event: Event, field: 'month' | 'compare') {
  const input = event.target as HTMLInputElement
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(input.value)) {
    if (field === 'month') month.value = input.value
    else compare.value = input.value
  } else input.value = field === 'month' ? month.value : compare.value
}
const report = computed(() => analysis.value?.report),
  latest = computed(() => analysis.value?.closures[0]),
  closed = computed(() => latest.value?.status === 'closed'),
  ended = computed(() => month.value < localDate().slice(0, 7))
const monthBudgets = computed(() => w.value.budgets.filter((b) => b.month === month.value))
async function act(op: 'period.close' | 'period.reopen' | 'period.prepare') {
  if (!analysis.value) return
  error.value = ''
  try {
    await command(
      {
        op,
        month: month.value,
        id: latest.value?.id,
        expectedRevision: analysis.value.revision,
        allowWarnings: allowWarnings.value,
        note: note.value,
        categoryIds: selectedCategories.value,
      },
      op === 'period.prepare' ? 'Следующий месяц подготовлен' : 'Состояние месяца сохранено',
    )
    await refresh()
  } catch (e: any) {
    error.value = e.message
  }
}
function reconcile(id: string) {
  reconciling.value = w.value.accounts.find((a) => a.id === id) || null
}
const delta = (value: string) => `${BigInt(value) > 0n ? '+' : ''}${money(value)}`
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>Итоги и проверка месяца<span class="title-dot">.</span></h1>
      <p>Сравнение периодов, причины отклонений и сохранённый итог.</p>
    </div>
  </div>
  <div class="form-row">
    <label
      >Месяц<input
        :value="month"
        type="month"
        required
        @change="selectPeriod($event, 'month')" /></label
    ><label
      >Сравнить с<input
        :value="compare"
        type="month"
        required
        @change="selectPeriod($event, 'compare')"
    /></label>
  </div>
  <p v-if="error || loadError" class="form-error" role="alert">
    {{ error || 'Не удалось загрузить итог. Повторите обновление.' }}
  </p>
  <p v-if="status === 'pending'" role="status">Загружаем итог…</p>
  <template v-if="report && analysis">
    <p v-if="closed" class="note-card">
      Месяц закрыт · версия {{ latest?.generation }}. Показан сохранённый итог; исправления требуют
      повторного открытия.
    </p>
    <div class="summary-strip">
      <div>
        <span>Доходы</span><strong>{{ money(report.income) }}</strong
        ><small>{{ delta(analysis.delta.income) }} к {{ compare }}</small>
      </div>
      <div>
        <span>Расходы с возвратами</span><strong>{{ money(report.expenses) }}</strong
        ><small>{{ delta(analysis.delta.expenses) }} к {{ compare }}</small>
      </div>
      <div>
        <span>Итог доходов и расходов</span><strong>{{ money(report.net) }}</strong
        ><small>{{ delta(analysis.delta.net) }} к {{ compare }}</small>
      </div>
      <div>
        <span>Ещё ожидается</span
        ><strong>{{ money(report.expectedIncome) }} / {{ money(report.expectedPayments) }}</strong
        ><small>поступления / платежи</small>
      </div>
    </div>
    <section class="panel form-stack">
      <h2>Категории и причины отклонения</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Категория</th>
              <th>Лимит</th>
              <th>Факт</th>
              <th>Открытый план</th>
              <th>Превышение</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in report.categories" :key="c.category">
              <td>
                <NuxtLink :to="{ path: '/transactions', query: { month, category: c.category } }">{{
                  c.category
                }}</NuxtLink>
              </td>
              <td>{{ c.limit === null ? 'Не задан' : money(c.limit) }}</td>
              <td>{{ money(c.spent) }}</td>
              <td>{{ money(c.planned) }}</td>
              <td>{{ money(c.over) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <details v-for="c in report.categories.filter((c) => BigInt(c.over) > 0n)" :key="c.category">
        <summary>{{ c.category }}: на {{ money(c.over) }} больше лимита</summary>
        <p v-for="id in c.transactionIds.slice(0, 10)" :key="id">
          <NuxtLink :to="{ path: '/transactions', query: { transaction: id } }"
            >{{ report.inputs.transactions.find((t) => t.id === id)?.date }} ·
            {{
              report.inputs.transactions.find((t) => t.id === id)?.description || c.category
            }}</NuxtLink
          >
        </p>
      </details>
    </section>
    <section class="panel form-stack">
      <h2>Регулярные расходы</h2>
      <div v-for="p in report.recurring" :key="p.id" class="summary-strip">
        <div>
          <span>{{ p.title }}</span
          ><strong>План {{ money(p.planned) }} · факт {{ money(p.actual) }}</strong>
        </div>
        <div>
          <span>Изменение факта к {{ compare }}</span
          ><strong>{{
            delta(
              (
                BigInt(p.actual) -
                BigInt(analysis.comparison.recurring.find((r) => r.id === p.id)?.actual || '0')
              ).toString(),
            )
          }}</strong>
        </div>
      </div>
    </section>
    <section class="panel form-stack">
      <h2>Долги и проценты</h2>
      <p>
        Изменение платежей по обязательствам к {{ compare }}:
        {{ delta(analysis.delta.debtPayments) }}.
      </p>
      <article v-for="o in report.obligations" :key="o.id">
        <h3>{{ o.title }}</h3>
        <p>
          Основной долг: {{ money(o.opening) }} → {{ money(o.closing) }}. Погашено
          {{ money(o.principal) }}, проценты {{ money(o.interest) }}, комиссии {{ money(o.fees) }}.
        </p>
      </article>
      <p v-for="a in report.accounts.filter((a) => a.creditDebt !== '0')" :key="a.id">
        {{ a.name }} · долг по карте на конец месяца: {{ money(a.creditDebt) }}
      </p>
      <p class="form-hint">
        Переводы погашения карты не увеличивают расходы. Платежи по обычным обязательствам следуют
        принятой в учёте модели расходов.
      </p>
    </section>
    <section class="panel form-stack">
      <h2>Проверка полноты учёта</h2>
      <p v-if="!report.issues.length">
        Вопросов по сверке остатков, категориям и открытым планам нет.
      </p>
      <ul v-else>
        <li v-for="(issue, index) in report.issues" :key="index">
          <span>{{ issue.message }} </span
          ><button
            v-if="issue.accountId && !closed"
            class="text-button"
            @click="reconcile(issue.accountId)"
          >
            Сверить</button
          ><NuxtLink
            v-if="issue.transactionId"
            :to="{ path: '/transactions', query: { transaction: issue.transactionId } }"
            >Открыть операцию</NuxtLink
          ><NuxtLink v-if="issue.planId" :to="{ path: '/calendar', query: { date: issue.dueDate } }"
            >В календарь</NuxtLink
          >
        </li>
      </ul>
      <div v-for="a in report.accounts" :key="a.id" class="inline-heading">
        <p>
          {{ a.name }}: {{ money(a.opening) }} → {{ money(a.closing) }} ·
          {{ a.reconciled ? 'остаток сверен' : 'требует сверки' }}
        </p>
      </div>
      <p class="form-hint">
        Проверка остатков не заменяет сверку каждой строки с выпиской. Начальные остатки в текущей
        модели действуют на всю историю.
      </p>
    </section>
    <section class="panel form-stack">
      <h2>{{ closed ? 'Открыть для исправлений' : 'Сохранить итог' }}</h2>
      <label
        >Комментарий<textarea
          v-model="note"
          maxlength="1000"
          placeholder="Причина открытия или пояснение оставшихся вопросов"
        /></label
      ><label v-if="!closed && report.issues.length"
        ><input v-model="allowWarnings" type="checkbox" /> Сохранить с указанными предупреждениями и
        моим комментарием</label
      ><button
        v-if="closed"
        class="button secondary"
        :disabled="pending || !note.trim()"
        @click="act('period.reopen')"
      >
        Открыть месяц</button
      ><button
        v-else
        class="button primary"
        :disabled="
          pending || !ended || (report.issues.length > 0 && (!allowWarnings || !note.trim()))
        "
        @click="act('period.close')"
      >
        Закрыть месяц
      </button>
      <p v-if="!ended" class="form-hint">
        Закрытие доступно после последнего дня месяца в часовом поясе пространства.
      </p>
      <p v-for="c in analysis.closures" :key="c.id">
        Версия {{ c.generation }} · {{ c.status === 'closed' ? 'Закрыта' : 'Повторно открыта' }} ·
        {{ new Date(c.createdAt).toLocaleString('ru-RU') }} · {{ c.note }}
        <a :href="`/api/period-export?id=${c.id}`" class="text-button">Скачать JSON</a>
      </p>
    </section>
    <section class="panel form-stack">
      <h2>Подготовить {{ shiftMonth(month, 1) }}</h2>
      <p class="form-hint">
        Выберите лимиты или оставьте выбор пустым для всех активных категорий. Уже заданные лимиты
        сохранятся; действующие планы продолжатся по своему графику.
      </p>
      <label v-for="b in monthBudgets" :key="b.id"
        ><input v-model="selectedCategories" type="checkbox" :value="b.categoryId" />
        {{ b.category }} · {{ money(b.limit) }}</label
      ><button class="button secondary" :disabled="pending" @click="act('period.prepare')">
        Подготовить следующий месяц
      </button>
    </section>
    <section class="panel form-stack">
      <h2>История лимитов</h2>
      <p v-for="h in analysis.history" :key="h.id">
        {{ new Date(h.createdAt).toLocaleString('ru-RU') }} · {{ h.category }}:
        {{ h.oldLimit === null ? 'нет лимита' : money(h.oldLimit) }} →
        {{ h.newLimit === null ? 'удалён' : money(h.newLimit) }} · ревизия {{ h.revision }}
      </p>
      <p class="form-hint">
        Точные пары изменений хранятся с версии схемы 15. Более ранние действия доступны в
        <NuxtLink to="/history">журнале команд</NuxtLink>.
      </p>
    </section>
  </template>
  <AppDialog
    :model-value="!!reconciling"
    title="Сверить остаток на конец месяца"
    @update:model-value="reconciling = null"
    ><ReconcileForm
      v-if="reconciling && report"
      :account="reconciling"
      :initial-date="report.to"
      @saved="reconciling = null"
  /></AppDialog>
</template>
