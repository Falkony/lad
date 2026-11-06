<script setup lang="ts">
import type { RecurringPayment, ProjectedPayment } from '../../shared/planning-types'
import { localDate, money, sumAmounts } from '../../shared/money'
import {
  projectPayments,
  recurringDates,
  monthRange,
  shiftMonth,
  frequencyLabel,
} from '../../shared/planning'
const { workspace: w, command, pending } = useWorkspace()
const open = ref(false),
  editing = ref<RecurringPayment | null>(null),
  month = ref(localDate().slice(0, 7)),
  filter = ref('active'),
  payment = ref<ProjectedPayment | null>(null)
const rows = computed(() => {
  const range = monthRange(month.value)
  return projectPayments(w.value, range.from, range.to)
})
const unpaid = computed(() => rows.value.filter((p) => ['pending', 'deleted'].includes(p.status)))
const paid = computed(() => rows.value.filter((p) => p.status === 'paid'))
const rules = computed(() =>
  w.value.recurringPayments.filter((r) => (filter.value === 'active' ? r.active : !r.active)),
)
const label = computed(() =>
  new Date(month.value + '-01T12:00:00')
    .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
    .replace(' г.', ''),
)
function edit(rule?: RecurringPayment) {
  editing.value = rule || null
  open.value = true
}
async function toggle(rule: RecurringPayment) {
  try {
    await command(
      { op: 'recurring.toggle', id: rule.id, active: !rule.active },
      rule.active ? 'Будущие повторы приостановлены' : 'Повторы возобновлены с сегодняшнего дня',
    )
  } catch {}
}
function next(rule: RecurringPayment) {
  if (!rule.active) return null
  const version = w.value.recurringVersions.find((v) => v.recurringId === rule.id && !v.validTo)
  return version
    ? recurringDates(
        version,
        localDate(),
        `${Math.min(9999, Number(localDate().slice(0, 4)) + rule.interval + 1)}-12-31`,
      )[0] || null
    : null
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ОБЯЗАТЕЛЬСТВА, О КОТОРЫХ НЕ НУЖНО ПОМНИТЬ</div>
      <h1>Регулярные платежи<span class="title-dot">.</span></h1>
      <p>Аренда, подписки и другие обязательные расходы по расписанию.</p>
    </div>
    <button class="button primary" @click="edit()">
      <AppIcon name="plus" :size="18" />Новое расписание
    </button>
  </div>
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
      <span>Ещё к оплате в этом месяце</span
      ><strong>{{ money(sumAmounts(unpaid.map((p) => p.amount))) }}</strong>
    </div>
    <div>
      <span>Подтверждено оплат</span
      ><strong
        >{{ paid.length }}
        <span class="muted"
          >· {{ money(sumAmounts(paid.map((p) => p.actualAmount || p.amount))) }}</span
        ></strong
      >
    </div>
    <div>
      <span>Пропущено дат</span
      ><strong>{{ rows.filter((p) => p.status === 'skipped').length }}</strong>
    </div>
  </div>
  <section class="recurring-rules-section">
    <div class="inline-heading">
      <h2>Расписания</h2>
      <span class="muted small">{{ w.recurringPayments.length }} всего</span>
    </div>
    <div class="account-tabs">
      <button :class="{ selected: filter === 'active' }" @click="filter = 'active'">
        Действуют · {{ w.recurringPayments.filter((r) => r.active).length }}</button
      ><button :class="{ selected: filter === 'paused' }" @click="filter = 'paused'">
        На паузе · {{ w.recurringPayments.filter((r) => !r.active).length }}
      </button>
    </div>
    <div class="recurring-rules-grid">
      <article v-for="rule in rules" :key="rule.id" class="panel recurring-rule">
        <div class="recurring-rule-top">
          <span class="account-symbol green"><AppIcon name="repeat" :size="22" /></span>
          <div>
            <h3>{{ rule.title }}</h3>
            <span>{{ rule.category }} · {{ frequencyLabel(rule.frequency, rule.interval) }}</span>
          </div>
          <button
            class="icon-button"
            :aria-label="`Редактировать расписание ${rule.title}`"
            @click="edit(rule)"
          >
            <AppIcon name="edit" :size="17" />
          </button>
        </div>
        <strong class="recurring-rule-amount">{{ money(rule.amount) }}</strong>
        <p class="recurring-rule-next">
          {{
            !rule.active
              ? 'Новые даты на паузе'
              : next(rule)
                ? `Следующая дата: ${new Date(next(rule)! + 'T12:00:00').toLocaleDateString('ru-RU')}`
                : 'Период расписания завершён'
          }}
        </p>
        <div class="recurring-rule-footer">
          <span>{{
            rule.accountId
              ? w.accounts.find((a) => a.id === rule.accountId)?.name
              : 'Счёт выбирается при оплате'
          }}</span
          ><button
            class="text-button"
            :disabled="pending"
            :aria-label="`${rule.active ? 'Приостановить' : 'Возобновить'} ${rule.title}`"
            @click="toggle(rule)"
          >
            <AppIcon :name="rule.active ? 'pause' : 'repeat'" :size="14" />{{
              rule.active ? 'Пауза' : 'Возобновить'
            }}
          </button>
        </div>
      </article>
    </div>
    <div v-if="!rules.length" class="panel empty-state">
      <AppIcon name="repeat" :size="32" /><strong>{{
        filter === 'active' ? 'Расписаний пока нет' : 'Нет приостановленных расписаний'
      }}</strong>
      <p>
        {{
          filter === 'active'
            ? 'Добавьте первый обязательный платёж — даты появятся в календаре.'
            : 'Приостановленные повторы можно возобновить в любой момент.'
        }}
      </p>
      <button v-if="filter === 'active'" class="button secondary" @click="edit()">
        Новое расписание
      </button>
    </div>
  </section>
  <section class="panel recurring-month-panel">
    <div class="panel-heading">
      <div>
        <h2>Платежи выбранного месяца</h2>
        <p>Отмечайте фактическую оплату или связывайте существующие расходы</p>
      </div>
    </div>
    <PaymentItem v-for="item in rows" :key="item.id" :payment="item" @pay="payment = $event" />
    <div v-if="!rows.length" class="empty-state">
      <AppIcon name="calendar" :size="28" />
      <p>В этом месяце нет платежей по расписаниям.</p>
    </div>
  </section>
  <AppDialog
    v-model="open"
    :title="editing ? 'Изменить расписание' : 'Новое расписание'"
    description="Сначала планируем даты. Расход записывается после подтверждения оплаты."
    ><RecurringForm :rule="editing" @saved="open = false" /></AppDialog
  ><PaymentDialog v-model="payment" />
</template>
