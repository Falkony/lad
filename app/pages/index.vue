<script setup lang="ts">
import { accountBalance, money, sumAmounts, localDate } from '../../shared/money'
import { projectPlans, overduePlans, isOpen, addDays } from '../../shared/planning'
import type { ProjectedOccurrence } from '../../shared/planning-types'

const { workspace: w, loading, pending, command } = useWorkspace()
const operationOpen = ref(false)
const current = new Date(),
  month = ref(new Date(current.getFullYear(), current.getMonth(), 1))
const monthKey = computed(() => localDate(month.value).slice(0, 7))
const monthLabel = computed(() =>
  new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
    .format(month.value)
    .replace(' г.', ''),
)
const monthTransactions = computed(() =>
  w.value.transactions.filter((t) => t.date.startsWith(monthKey.value)),
)
const income = computed(() =>
  sumAmounts(monthTransactions.value.filter((t) => t.kind === 'income').map((t) => t.amount)),
)
const expenses = computed(() =>
  sumAmounts(monthTransactions.value.filter((t) => t.kind === 'expense').map((t) => t.amount)),
)
const balance = computed(() =>
  sumAmounts(w.value.accounts.map((a) => accountBalance(a, w.value.transactions))),
)
const overdueCount = computed(() => overduePlans(w.value, localDate()).length)
const upcoming = computed(() =>
  [
    ...w.value.events.map((e) => ({ ...e, plan: null as ProjectedOccurrence | null })),
    ...projectPlans(w.value, localDate(), addDays(localDate(), 90))
      .filter(isOpen)
      .map((p) => ({
        id: p.id,
        title: p.title,
        date: p.date,
        kind: p.direction === 'income' ? 'income' : 'payment',
        amount: p.amount as string | null,
        done: false,
        note: p.note,
        plan: p,
      })),
  ]
    .filter((e) => !e.done && e.date >= localDate())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3),
)
const goals = computed(() => w.value.goals.filter((g) => g.status !== 'done').slice(0, 2))
const palette = ['#365b48', '#97ad91', '#d8bb83', '#d8977b', '#b9c5cd', '#c8beae']
const breakdown = computed(() => {
  const totals: Record<string, bigint> = {}
  for (const t of monthTransactions.value.filter((t) => t.kind === 'expense'))
    totals[t.category] = (totals[t.category] || 0n) + BigInt(t.amount)
  return Object.entries(totals)
    .sort((a, b) => (a[1] > b[1] ? -1 : 1))
    .map(([name, value], i) => ({
      name,
      value: value.toString(),
      percent: (Number(value) / (Number(expenses.value) || 1)) * 100,
      color: palette[i % palette.length],
    }))
})
const donutStyle = computed(() => {
  let offset = 0
  return {
    background: breakdown.value.length
      ? `conic-gradient(${breakdown.value
          .map((x) => {
            const start = offset
            offset += x.percent
            return `${x.color} ${start}% ${offset}%`
          })
          .join(',')})`
      : '#eaece5',
  }
})
const chart = computed(() => {
  const days = new Date(month.value.getFullYear(), month.value.getMonth() + 1, 0).getDate()
  const isCurrent = monthKey.value === localDate().slice(0, 7)
  const end = isCurrent ? current.getDate() : month.value > current ? 0 : days
  let value = Number(sumAmounts(w.value.accounts.map((a) => a.openingBalance)))
  for (const t of w.value.transactions.filter((t) => t.date < `${monthKey.value}-01`))
    if (t.kind !== 'transfer')
      value += (t.kind === 'income' || t.kind === 'adjustment' ? 1 : -1) * Number(t.amount)
  const values = [value]
  for (let day = 1; day <= end; day++) {
    for (const t of monthTransactions.value.filter((t) => Number(t.date.slice(-2)) === day))
      if (t.kind !== 'transfer')
        value += (t.kind === 'income' || t.kind === 'adjustment' ? 1 : -1) * Number(t.amount)
    values.push(value)
  }
  const low = Math.min(...values),
    high = Math.max(...values),
    padding = Math.max((high - low) * 0.12, 10000)
  const min = low - padding,
    range = high - low + padding * 2
  const points = values
    .map((v, i) => `${(i / days) * 600},${145 - ((v - min) / range) * 125}`)
    .join(' ')
  return {
    points,
    area: `0,165 ${points} ${(end / days) * 600},165`,
    days,
    end,
    ticks: [min + range, min + range / 2, min].map((v) => money(BigInt(Math.round(v)), true)),
  }
})
function moveMonth(delta: number) {
  month.value = new Date(month.value.getFullYear(), month.value.getMonth() + delta, 1)
}
function dateLabel(date: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(
    new Date(date + 'T12:00:00'),
  )
}
function progress(saved: string, target: string) {
  return Math.min(100, Math.round((Number(saved) / Number(target)) * 100))
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ДЕНЬГИ ПОД КОНТРОЛЕМ</div>
      <h1>Всё идёт по плану<span class="title-dot">.</span></h1>
      <p>Вся картина перед глазами. Можно выдохнуть.</p>
    </div>
    <button class="button primary" @click="operationOpen = true">
      <AppIcon name="plus" :size="18" />Добавить операцию
    </button>
  </div>
  <div class="section-toolbar">
    <div class="period-control">
      <button class="icon-button" aria-label="Предыдущий месяц" @click="moveMonth(-1)">
        <AppIcon name="left" :size="16" /></button
      ><span>{{ monthLabel }}</span
      ><button class="icon-button" aria-label="Следующий месяц" @click="moveMonth(1)">
        <AppIcon name="right" :size="16" />
      </button>
    </div>
    <span class="muted small"
      ><span class="status-dot" />{{ loading ? 'Загружаем данные…' : 'Актуально на сегодня' }}</span
    >
  </div>
  <section class="stats-grid" aria-label="Финансовая сводка">
    <article class="stat-card balance-card">
      <div class="stat-top"><span>Всего на счетах</span><AppIcon name="wallet" :size="20" /></div>
      <div class="stat-value">{{ money(balance) }}</div>
      <div class="stat-foot">
        <span class="balance-dot" />{{ w.accounts.length }}
        {{ w.accounts.length === 1 ? 'счёт' : 'счета' }} · общий остаток
      </div>
      <svg class="balance-decoration" viewBox="0 0 180 130">
        <circle cx="145" cy="85" r="68" />
        <circle cx="145" cy="85" r="49" />
        <circle cx="145" cy="85" r="30" />
      </svg>
    </article>
    <article class="stat-card">
      <div class="stat-top">
        <span>Доходы за месяц</span
        ><span class="stat-icon income"><AppIcon name="income" :size="19" /></span>
      </div>
      <div class="stat-value">{{ money(income) }}</div>
      <div class="stat-foot">
        <span class="soft-badge green"
          >{{ monthTransactions.filter((t) => t.kind === 'income').length }} операций</span
        ><span>поступило на счета</span>
      </div>
    </article>
    <article class="stat-card">
      <div class="stat-top">
        <span>Расходы за месяц</span
        ><span class="stat-icon expense"><AppIcon name="expense" :size="19" /></span>
      </div>
      <div class="stat-value">{{ money(expenses) }}</div>
      <div class="stat-foot">
        <span class="soft-badge sand"
          >{{ monthTransactions.filter((t) => t.kind === 'expense').length }} операций</span
        ><span>без переводов между счетами</span>
      </div>
    </article>
  </section>
  <AccountSection />
  <BudgetOverview :month="monthKey" />
  <div class="analytics-grid">
    <section class="panel chart-panel">
      <div class="panel-heading">
        <div>
          <h2>Деньги в движении</h2>
          <p>Общий остаток по дням месяца</p>
        </div>
        <span class="chart-legend"><i />Баланс</span>
      </div>
      <div class="line-chart">
        <div class="chart-y">
          <span v-for="tick in chart.ticks" :key="tick">{{ tick }}</span>
        </div>
        <div class="chart-plot">
          <svg
            viewBox="0 0 600 170"
            preserveAspectRatio="none"
            role="img"
            aria-label="График общего остатка по дням"
          >
            <defs>
              <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="#789b75" stop-opacity=".23" />
                <stop offset="100%" stop-color="#789b75" stop-opacity="0" />
              </linearGradient>
            </defs>
            <path
              v-for="y in [20, 82, 145]"
              :key="y"
              :d="`M0 ${y}H600`"
              stroke="#e8ebe4"
              stroke-dasharray="3 5"
            />
            <polygon :points="chart.area" fill="url(#chart-fill)" />
            <polyline
              :points="chart.points"
              fill="none"
              stroke="#60815b"
              stroke-width="2.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <div class="chart-x">
            <span>1 {{ monthLabel.split(' ')[0]?.slice(0, 3) }}</span
            ><span>7</span><span>14</span><span>21</span><span>{{ chart.days }}</span>
          </div>
        </div>
      </div>
      <div class="chart-bottom">
        <AppIcon name="sprout" :size="16" /><span
          >Учитываем операции и корректировки. Переводы не меняют общий баланс.</span
        >
      </div>
    </section>
    <section class="panel spending-panel">
      <div class="panel-heading">
        <div>
          <h2>Куда уходят деньги</h2>
          <p>Расходы по категориям</p>
        </div>
        <NuxtLink to="/transactions" class="icon-button" aria-label="Все расходы"
          ><AppIcon name="arrow" :size="18"
        /></NuxtLink>
      </div>
      <div class="spending-body">
        <div class="donut" :style="donutStyle">
          <div>
            <span>Всего</span><strong>{{ money(expenses) }}</strong>
          </div>
        </div>
        <div class="category-legend">
          <div v-for="item in breakdown.slice(0, 5)" :key="item.name">
            <i :style="{ background: item.color }" /><span>{{ item.name }}</span
            ><strong>{{ Math.round(item.percent) }}%</strong>
          </div>
          <span v-if="!breakdown.length" class="muted small"
            >Здесь появится структура ваших расходов</span
          ><span v-if="breakdown.length > 5" class="legend-more"
            >+ {{ breakdown.length - 5 }} категории</span
          >
        </div>
      </div>
    </section>
  </div>
  <div class="bottom-grid">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <h2>Последние операции</h2>
          <p>Повседневность в цифрах</p>
        </div>
        <NuxtLink to="/transactions" class="text-button"
          >Все операции <AppIcon name="arrow" :size="15"
        /></NuxtLink>
      </div>
      <TransactionList :transactions="w.transactions.slice(0, 4)" />
    </section>
    <section class="panel upcoming-panel">
      <div class="panel-heading">
        <div>
          <h2>На горизонте</h2>
          <p>Чтобы ничего не упустить</p>
        </div>
        <NuxtLink to="/calendar" class="icon-button" aria-label="Весь календарь"
          ><AppIcon name="calendar" :size="18"
        /></NuxtLink>
      </div>
      <NuxtLink v-if="overdueCount" to="/plans" class="upcoming-row overdue-row"
        ><div class="date-tile"><AppIcon name="bell" :size="18" /></div>
        <div>
          <strong>Требуют решения: {{ overdueCount }}</strong
          ><span>Срок прошёл — подтвердите, перенесите или отмените</span>
        </div></NuxtLink
      >
      <NuxtLink
        v-for="event in upcoming"
        :key="event.id"
        :to="{ path: '/calendar', query: { date: event.date } }"
        class="upcoming-row"
        ><div class="date-tile">
          <strong>{{ Number(event.date.slice(-2)) }}</strong
          ><span>{{ dateLabel(event.date).split(' ').slice(1).join(' ') }}</span>
        </div>
        <div>
          <strong>{{ event.title }}</strong
          ><span>{{
            !event.plan
              ? 'Личные планы'
              : event.plan.direction === 'income'
                ? 'Ожидаемое поступление'
                : event.plan.frequency === 'once'
                  ? 'Разовый платёж'
                  : 'Регулярный платёж'
          }}</span>
        </div>
        <strong
          v-if="event.amount"
          class="upcoming-amount"
          :class="{ 'text-green': event.kind === 'income' }"
          >{{ event.kind === 'income' ? '+' : '' }}{{ money(event.amount, true) }}</strong
        ></NuxtLink
      >
      <div v-if="!upcoming.length" class="empty-state compact">
        <AppIcon name="calendar" :size="26" />
        <p>Ближайших дел пока нет.<br />Самое время что-нибудь запланировать.</p>
      </div>
      <NuxtLink to="/calendar" class="panel-bottom-link"
        >Открыть календарь <AppIcon name="arrow" :size="15"
      /></NuxtLink>
    </section>
  </div>
  <section class="goals-preview">
    <div class="inline-heading">
      <h2>Ближе к желаемому <span class="heading-spark">✧</span></h2>
      <NuxtLink to="/goals" class="text-button"
        >Все цели <AppIcon name="arrow" :size="15"
      /></NuxtLink>
    </div>
    <div class="goals-preview-grid">
      <NuxtLink v-for="g in goals" :key="g.id" to="/goals" class="goal-preview"
        ><span class="goal-preview-icon"
          ><AppIcon :name="g.title.includes('Подушка') ? 'sprout' : 'target'" :size="24"
        /></span>
        <div>
          <strong>{{ g.title }}</strong>
          <div class="goal-preview-amount">
            {{ money(g.saved, true) }} <span>из {{ money(g.target, true) }}</span>
          </div>
          <div class="progress-bar">
            <span :style="{ width: `${progress(g.saved, g.target)}%` }" />
          </div>
        </div>
        <span class="goal-percent">{{ progress(g.saved, g.target) }}%</span></NuxtLink
      ><NuxtLink v-if="!goals.length" to="/goals" class="empty-goals"
        ><AppIcon name="target" /><span>У каждой большой цели есть первый шаг</span
        ><strong>Добавить цель <AppIcon name="arrow" :size="14" /></strong
      ></NuxtLink>
    </div>
  </section>
  <AppDialog
    v-model="operationOpen"
    title="Новая операция"
    description="Запишите сейчас — и картина станет точнее."
    ><TransactionForm @saved="operationOpen = false"
  /></AppDialog>
</template>
