<script setup lang="ts">
import type { ProjectedOccurrence } from '../../shared/planning-types'
import type { ForecastEvent } from '../../shared/forecast'
import { forecast, forecastFlows } from '../../shared/forecast'
import { accountBalance, localDate, money } from '../../shared/money'
import { projectOccurrence } from '../../shared/planning'
const { workspace: w } = useWorkspace()
const horizons = [30, 60, 90] as const
const days = ref<(typeof horizons)[number]>(30)
const today = computed(() => localDate())
const result = computed(() => forecast(w.value, today.value, days.value))
const flows = computed(() => forecastFlows(w.value, `${today.value.slice(0, 7)}-01`, today.value))
const confirming = ref<ProjectedOccurrence | null>(null)
const accountName = (id: string | null) =>
  id ? w.value.accounts.find((a) => a.id === id)?.name || 'Счёт удалён' : 'Счёт не выбран'
const formatDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
const negative = (value: string) => BigInt(value) < 0n
const accountBalanceOf = (id: string) => {
  const account = w.value.accounts.find((a) => a.id === id)
  return account ? accountBalance(account, w.value.transactions) : '0'
}
const signed = (e: ForecastEvent) => `${e.direction === 'income' ? '+' : '−'}${money(e.amount)}`
/** Days with planned money, with the expected total at the end of each day. */
const timeline = computed(() => result.value.days.filter((d) => d.events.length))
const deficits = computed(() => result.value.accounts.filter((a) => a.deficitDate))
function confirm(event: ForecastEvent) {
  confirming.value = projectOccurrence(w.value, event.planId, event.dueDate) || null
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ЧТО БУДЕТ С ДЕНЬГАМИ</div>
      <h1>Прогноз<span class="title-dot">.</span></h1>
      <p>Ожидаемый остаток по введённым планам: хватит ли денег на платежи до поступлений.</p>
    </div>
    <div class="account-tabs forecast-horizon" role="group" aria-label="Горизонт прогноза">
      <button
        v-for="h in horizons"
        :key="h"
        :class="{ selected: days === h }"
        :aria-pressed="days === h"
        @click="days = h"
      >
        {{ h }} дней
      </button>
    </div>
  </div>

  <section
    v-if="result.total.deficitDate || deficits.length"
    class="panel forecast-alert"
    role="alert"
  >
    <AppIcon name="bell" :size="20" />
    <div>
      <strong v-if="result.total.deficitDate"
        >Денег не хватит с {{ formatDate(result.total.deficitDate) }}: общий остаток станет
        отрицательным, минимум {{ money(result.total.min) }}
        {{ formatDate(result.total.minDate) }}</strong
      >
      <strong v-else>Общего остатка хватает, но на отдельных счетах будет минус</strong>
      <p v-for="a in deficits" :key="a.account.id">
        {{ a.account.name }}: минус с {{ formatDate(a.deficitDate!) }}, минимум {{ money(a.min) }}
        {{ formatDate(a.minDate) }}. Перенесите платёж, переведите деньги на этот счёт или выберите
        другой счёт для плана.
      </p>
    </div>
  </section>

  <div class="summary-strip">
    <div>
      <span>Сейчас на счетах прогноза</span><strong>{{ money(result.total.start) }}</strong>
    </div>
    <div>
      <span>Минимальный остаток · {{ formatDate(result.total.minDate) }}</span
      ><strong :class="{ 'danger-text': negative(result.total.min) }">{{
        money(result.total.min)
      }}</strong>
    </div>
    <div>
      <span>Через {{ days }} дней · {{ formatDate(result.to) }}</span
      ><strong :class="{ 'danger-text': negative(result.total.end) }">{{
        money(result.total.end)
      }}</strong>
    </div>
  </div>

  <div class="forecast-grid">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <h2>Остаток по дням</h2>
          <p>Конец каждого дня, все счета прогноза и планы без счёта</p>
        </div>
      </div>
      <ForecastChart :days="result.days" :start="result.total.start" />
    </section>
    <section class="panel">
      <div class="panel-heading">
        <div>
          <h2>До следующего поступления</h2>
          <p>Что нужно оплатить, пока деньги не пришли</p>
        </div>
      </div>
      <ForecastNextIncome :result="result" :days="days" />
    </section>
  </div>

  <section class="panel forecast-section">
    <div class="panel-heading">
      <div>
        <h2>По счетам</h2>
        <p>Плановая дата без счёта меняет только общий итог</p>
      </div>
      <NuxtLink to="/accounts" class="text-button"
        >Настроить счета <AppIcon name="settings" :size="14"
      /></NuxtLink>
    </div>
    <div class="forecast-table" role="table" aria-label="Прогноз по счетам">
      <div class="forecast-row head" role="row">
        <span role="columnheader">Счёт</span><span role="columnheader">Сейчас</span
        ><span role="columnheader">Поступления</span><span role="columnheader">Платежи</span
        ><span role="columnheader">Минимум</span
        ><span role="columnheader">Через {{ days }} дн.</span>
      </div>
      <div v-for="a in result.accounts" :key="a.account.id" class="forecast-row" role="row">
        <span role="cell"
          ><strong>{{ a.account.name }}</strong
          ><em v-if="a.deficitDate" class="danger-text"
            >минус с {{ formatDate(a.deficitDate) }}</em
          ></span
        ><span role="cell" data-label="Сейчас">{{ money(a.start) }}</span
        ><span role="cell" data-label="Поступления" class="text-green">+{{ money(a.incomes) }}</span
        ><span role="cell" data-label="Платежи">−{{ money(a.payments) }}</span
        ><span role="cell" data-label="Минимум" :class="{ 'danger-text': negative(a.min) }"
          >{{ money(a.min) }} <small>{{ formatDate(a.minDate) }}</small></span
        ><span role="cell" data-label="В конце" :class="{ 'danger-text': negative(a.end) }">{{
          money(a.end)
        }}</span>
      </div>
      <div v-if="result.unassigned.events.length" class="forecast-row muted-row" role="row">
        <span role="cell"><strong>Без счёта</strong><em>счёт выбирается при подтверждении</em></span
        ><span role="cell" data-label="Сейчас">—</span
        ><span role="cell" data-label="Поступления" class="text-green"
          >+{{ money(result.unassigned.incomes) }}</span
        ><span role="cell" data-label="Платежи">−{{ money(result.unassigned.payments) }}</span
        ><span role="cell" data-label="Минимум">—</span
        ><span role="cell" data-label="В конце">—</span>
      </div>
      <div class="forecast-row total" role="row">
        <span role="cell"><strong>Итого</strong></span
        ><span role="cell" data-label="Сейчас">{{ money(result.total.start) }}</span
        ><span role="cell" data-label="Поступления" class="text-green"
          >+{{ money(result.total.incomes) }}</span
        ><span role="cell" data-label="Платежи">−{{ money(result.total.payments) }}</span
        ><span
          role="cell"
          data-label="Минимум"
          :class="{ 'danger-text': negative(result.total.min) }"
          >{{ money(result.total.min) }} <small>{{ formatDate(result.total.minDate) }}</small></span
        ><span
          role="cell"
          data-label="В конце"
          :class="{ 'danger-text': negative(result.total.end) }"
          >{{ money(result.total.end) }}</span
        >
      </div>
    </div>
    <p v-if="!result.accounts.length" class="form-hint forecast-note">
      Ни один счёт не участвует в прогнозе. Включите «Учитывать в прогнозе» в настройках счёта.
    </p>
  </section>

  <section class="panel forecast-section">
    <div class="panel-heading">
      <div>
        <h2>Из чего складывается прогноз</h2>
        <p>Каждая плановая дата учитывается один раз: подтверждённая уже входит в остаток</p>
      </div>
    </div>
    <div v-if="timeline.length" class="forecast-timeline">
      <div v-for="day in timeline" :key="day.date" class="forecast-day">
        <div class="forecast-day-head">
          <strong>{{ day.date === today ? 'Сегодня' : formatDate(day.date) }}</strong
          ><span :class="{ 'danger-text': negative(day.total) }"
            >остаток {{ money(day.total) }}</span
          >
        </div>
        <div v-for="event in day.events" :key="event.id" class="forecast-event">
          <span class="account-symbol" :class="event.direction === 'income' ? 'blue' : 'green'"
            ><AppIcon :name="event.direction" :size="16"
          /></span>
          <div>
            <strong>{{ event.title }}</strong>
            <span class="muted small"
              >{{ event.category }} · {{ accountName(event.accountId)
              }}<template v-if="event.overdue">
                · <em class="danger-text">срок был {{ formatDate(event.dueDate) }}</em></template
              ></span
            >
          </div>
          <strong :class="{ 'text-green': event.direction === 'income' }">{{
            signed(event)
          }}</strong>
          <button class="text-button" @click="confirm(event)">
            {{ event.direction === 'income' ? 'Получил' : 'Оплатил' }}
          </button>
        </div>
      </div>
    </div>
    <div v-else class="empty-state">
      <AppIcon name="calendar" :size="28" />
      <p>
        На ближайшие {{ days }} дней нет плановых поступлений и платежей — прогноз равен текущему
        остатку.
      </p>
      <NuxtLink to="/plans" class="button secondary">Добавить план</NuxtLink>
    </div>
  </section>

  <div class="forecast-grid">
    <section class="panel forecast-section">
      <div class="panel-heading">
        <div>
          <h2>С начала месяца</h2>
          <p>Как менялся остаток на счетах прогноза</p>
        </div>
      </div>
      <dl class="forecast-flows">
        <div>
          <dt>Остаток на 1-е число</dt>
          <dd>{{ money(flows.opening) }}</dd>
        </div>
        <div>
          <dt>Доходы</dt>
          <dd class="text-green">+{{ money(flows.incomes) }}</dd>
        </div>
        <div>
          <dt>Расходы</dt>
          <dd>−{{ money(flows.expenses) }}</dd>
        </div>
        <div v-if="flows.adjustments !== '0'">
          <dt>Корректировки остатка</dt>
          <dd>{{ negative(flows.adjustments) ? '' : '+' }}{{ money(flows.adjustments) }}</dd>
        </div>
        <div>
          <dt>Переводы на счета вне прогноза</dt>
          <dd>−{{ money(flows.transfersOut) }}</dd>
        </div>
        <div v-if="flows.transfersIn !== '0'">
          <dt>Переводы со счетов вне прогноза</dt>
          <dd class="text-green">+{{ money(flows.transfersIn) }}</dd>
        </div>
        <div class="total">
          <dt>Сейчас</dt>
          <dd>{{ money(flows.closing) }}</dd>
        </div>
      </dl>
    </section>
    <section class="panel forecast-section">
      <div class="panel-heading">
        <div>
          <h2>Накопления и резервы</h2>
          <p>Счета вне прогноза: эти деньги не считаются доступными для текущих платежей</p>
        </div>
      </div>
      <div v-if="result.outside.accounts.length" class="forecast-outside">
        <div v-for="a in result.outside.accounts" :key="a.id" class="forecast-outside-row">
          <span class="account-symbol" :class="a.color"><AppIcon :name="a.kind" :size="16" /></span
          ><span>{{ a.name }}</span>
          <strong>{{ money(accountBalanceOf(a.id)) }}</strong>
        </div>
        <div class="forecast-outside-row total">
          <span /><span>Всего</span><strong>{{ money(result.outside.balance) }}</strong>
        </div>
        <p v-if="result.outside.events.length" class="form-hint">
          Планы на этих счетах в прогноз не входят:
          {{ result.outside.events.map((e) => `${e.title} (${formatDate(e.date)})`).join(', ') }}.
        </p>
      </div>
      <div v-else class="empty-state">
        <AppIcon name="savings" :size="28" />
        <p>
          Все счета участвуют в прогнозе. Отключите накопительный счёт в его настройках, чтобы
          резерв не считался деньгами на текущие траты.
        </p>
      </div>
    </section>
  </div>
  <PlanConfirmDialog v-model="confirming" />
</template>
