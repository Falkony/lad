<script setup lang="ts">
import type { Plan, ProjectedOccurrence } from '../../shared/planning-types'
import { localDate, money, sumAmounts } from '../../shared/money'
import {
  projectPlans,
  projectOccurrence,
  monthRange,
  shiftMonth,
  frequencyLabel,
  overduePlans,
  isOpen,
} from '../../shared/planning'
const { workspace: w, command, pending } = useWorkspace()
const open = ref(false),
  editing = ref<Plan | null>(null),
  removing = ref<Plan | null>(null),
  month = ref(localDate().slice(0, 7)),
  filter = ref<'recurring' | 'once' | 'paused'>('recurring'),
  confirming = ref<ProjectedOccurrence | null>(null)
const rows = computed(() => {
  const range = monthRange(month.value)
  return projectPlans(w.value, range.from, range.to)
})
const overdue = computed(() => overduePlans(w.value, localDate()))
const openSum = (direction: 'income' | 'expense') =>
  sumAmounts(rows.value.filter((p) => p.direction === direction && isOpen(p)).map((p) => p.amount))
const counts = computed(() => ({
  recurring: w.value.plans.filter((p) => p.frequency !== 'once' && p.active).length,
  once: w.value.plans.filter((p) => p.frequency === 'once').length,
  paused: w.value.plans.filter((p) => p.frequency !== 'once' && !p.active).length,
}))
const plans = computed(() =>
  w.value.plans
    .filter((p) =>
      filter.value === 'once'
        ? p.frequency === 'once'
        : p.frequency !== 'once' && p.active === (filter.value === 'recurring'),
    )
    .sort((a, b) =>
      filter.value === 'once'
        ? b.startDate.localeCompare(a.startDate)
        : a.title.localeCompare(b.title, 'ru'),
    ),
)
const label = computed(() =>
  new Date(month.value + '-01T12:00:00')
    .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
    .replace(' г.', ''),
)
const formatDate = (date: string) => new Date(date + 'T12:00:00').toLocaleDateString('ru-RU')
function edit(plan?: Plan) {
  editing.value = plan || null
  open.value = true
}
async function toggle(plan: Plan) {
  try {
    await command(
      { op: 'plan.toggle', id: plan.id, active: !plan.active },
      plan.active ? 'Будущие повторы приостановлены' : 'Повторы возобновлены с сегодняшнего дня',
    )
  } catch {}
}
async function remove() {
  if (!removing.value) return
  try {
    await command({ op: 'plan.delete', id: removing.value.id }, 'План удалён')
    removing.value = null
  } catch {}
}
function status(plan: Plan) {
  if (plan.frequency === 'once') {
    const item = projectOccurrence(w.value, plan.id, plan.startDate)
    if (!item) return 'Дата не найдена'
    if (item.status === 'paid')
      return `${plan.direction === 'income' ? 'Получено' : 'Оплачено'} ${formatDate(item.actualDate || item.date)}`
    if (item.status === 'skipped') return 'Отменено'
    if (item.status === 'closed') return 'Отмечено без операции'
    return `${item.date < localDate() ? 'Срок прошёл' : 'Дата'}: ${formatDate(item.date)}`
  }
  if (!plan.active) return 'Новые даты на паузе'
  const today = localDate()
  const until = `${Math.min(9999, Number(today.slice(0, 4)) + plan.interval + 1)}-12-31`
  // Effective dates: a moved or cancelled date must not show up as "next".
  const next = projectPlans(w.value, today, until).find((p) => p.planId === plan.id && isOpen(p))
  return next ? `Следующая дата: ${formatDate(next.date)}` : 'Период плана завершён'
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ДЕНЬГИ, КОТОРЫЕ ЕЩЁ ПРИДУТ И УЙДУТ</div>
      <h1>Поступления и платежи<span class="title-dot">.</span></h1>
      <p>Зарплата, аренда, подписки и разовые планы — в одном расписании.</p>
    </div>
    <button class="button primary" @click="edit()">
      <AppIcon name="plus" :size="18" />Новый план
    </button>
  </div>
  <section v-if="overdue.length" class="panel recurring-month-panel overdue-panel">
    <div class="panel-heading">
      <div>
        <h2>Требуют решения · {{ overdue.length }}</h2>
        <p>Срок прошёл: подтвердите, перенесите или отмените дату</p>
      </div>
    </div>
    <PlanItem v-for="item in overdue" :key="item.id" :item="item" @confirm="confirming = $event" />
  </section>
  <div class="section-toolbar">
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
    <NuxtLink :to="{ path: '/calendar', query: { date: `${month}-01` } }" class="text-button"
      >В календаре <AppIcon name="calendar" :size="16"
    /></NuxtLink>
  </div>
  <div class="summary-strip">
    <div>
      <span>Ожидается поступлений</span
      ><strong class="text-green">+{{ money(openSum('income')) }}</strong>
    </div>
    <div>
      <span>Ещё к оплате</span><strong>{{ money(openSum('expense')) }}</strong>
    </div>
    <div>
      <span>Подтверждено дат</span
      ><strong>{{ rows.filter((p) => p.status === 'paid').length }}</strong>
    </div>
  </div>
  <section class="recurring-rules-section">
    <div class="inline-heading">
      <h2>Планы</h2>
      <span class="muted small">{{ w.plans.length }} всего</span>
    </div>
    <div class="account-tabs">
      <button :class="{ selected: filter === 'recurring' }" @click="filter = 'recurring'">
        Регулярные · {{ counts.recurring }}</button
      ><button :class="{ selected: filter === 'once' }" @click="filter = 'once'">
        Разовые · {{ counts.once }}</button
      ><button :class="{ selected: filter === 'paused' }" @click="filter = 'paused'">
        На паузе · {{ counts.paused }}
      </button>
    </div>
    <div class="recurring-rules-grid">
      <article
        v-for="plan in plans"
        :key="plan.id"
        class="panel recurring-rule"
        :class="plan.direction"
      >
        <div class="recurring-rule-top">
          <span class="account-symbol" :class="plan.direction === 'income' ? 'blue' : 'green'"
            ><AppIcon
              :name="
                plan.direction === 'income'
                  ? 'income'
                  : plan.frequency === 'once'
                    ? 'calendar'
                    : 'repeat'
              "
              :size="22"
          /></span>
          <div>
            <h3>{{ plan.title }}</h3>
            <span
              >{{ plan.direction === 'income' ? 'Поступление' : 'Платёж' }} · {{ plan.category }} ·
              {{ frequencyLabel(plan.frequency, plan.interval, plan.monthDays)
              }}{{ plan.holidayShift === 'before' ? ' · с выходных раньше' : '' }}</span
            >
          </div>
          <button
            class="icon-button"
            :aria-label="`Редактировать план ${plan.title}`"
            @click="edit(plan)"
          >
            <AppIcon name="edit" :size="17" />
          </button>
        </div>
        <strong class="recurring-rule-amount" :class="{ 'text-green': plan.direction === 'income' }"
          >{{ plan.direction === 'income' ? '+' : '' }}{{ money(plan.amount) }}</strong
        >
        <p class="recurring-rule-next">{{ status(plan) }}</p>
        <div class="recurring-rule-footer">
          <span>{{
            plan.accountId
              ? w.accounts.find((a) => a.id === plan.accountId)?.name
              : 'Счёт выбирается при подтверждении'
          }}</span
          ><span class="rule-actions"
            ><button
              v-if="plan.frequency !== 'once'"
              class="text-button"
              :disabled="pending"
              :aria-label="`${plan.active ? 'Приостановить' : 'Возобновить'} ${plan.title}`"
              @click="toggle(plan)"
            >
              <AppIcon :name="plan.active ? 'pause' : 'repeat'" :size="14" />{{
                plan.active ? 'Пауза' : 'Возобновить'
              }}</button
            ><button
              class="text-button"
              :disabled="pending"
              :aria-label="`Удалить план ${plan.title}`"
              @click="removing = plan"
            >
              <AppIcon name="delete" :size="14" />Удалить
            </button></span
          >
        </div>
      </article>
    </div>
    <div v-if="!plans.length" class="panel empty-state">
      <AppIcon name="repeat" :size="32" /><strong>{{
        filter === 'paused'
          ? 'Нет приостановленных планов'
          : filter === 'once'
            ? 'Разовых планов пока нет'
            : 'Регулярных планов пока нет'
      }}</strong>
      <p>
        {{
          filter === 'paused'
            ? 'Приостановленные повторы можно возобновить в любой момент.'
            : 'Добавьте зарплату, аренду или разовый платёж — даты появятся в календаре.'
        }}
      </p>
      <button v-if="filter !== 'paused'" class="button secondary" @click="edit()">
        Новый план
      </button>
    </div>
  </section>
  <section class="panel recurring-month-panel">
    <div class="panel-heading">
      <div>
        <h2>Даты выбранного месяца</h2>
        <p>Подтверждайте поступления и оплаты, переносите и отменяйте отдельные даты</p>
      </div>
    </div>
    <PlanItem v-for="item in rows" :key="item.id" :item="item" @confirm="confirming = $event" />
    <div v-if="!rows.length" class="empty-state">
      <AppIcon name="calendar" :size="28" />
      <p>В этом месяце нет запланированных поступлений и платежей.</p>
    </div>
  </section>
  <AppDialog
    v-model="open"
    :title="editing ? 'Изменить план' : 'Новый план'"
    description="Сначала планируем даты. Операция записывается после подтверждения."
    ><PlanForm :plan="editing" @saved="open = false" /></AppDialog
  ><AppDialog
    :model-value="!!removing"
    title="Удалить план?"
    :description="removing?.title"
    @update:model-value="removing = null"
    ><p class="form-hint">
      План и все его даты исчезнут из календаря. Если какая-то дата уже подтверждена операцией,
      удалить план нельзя — поставьте его на паузу.
    </p>
    <div class="dialog-actions">
      <button class="button secondary" @click="removing = null">Отмена</button
      ><button class="button danger" :disabled="pending" @click="remove">Удалить</button>
    </div></AppDialog
  ><PlanConfirmDialog v-model="confirming" />
</template>
