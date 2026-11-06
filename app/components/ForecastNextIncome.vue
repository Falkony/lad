<script setup lang="ts">
import { untilNextIncome, type Forecast } from '../../shared/forecast'
import { money } from '../../shared/money'
const props = defineProps<{ result: Forecast; days: number }>()
const next = computed(() => untilNextIncome(props.result))
const formatDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
const daysLeft = computed(() =>
  next.value
    ? Math.round((Date.parse(next.value.income.date) - Date.parse(props.result.from)) / 86400000)
    : 0,
)
</script>
<template>
  <div class="forecast-next">
    <template v-if="next">
      <div class="forecast-next-income">
        <span class="account-symbol blue"><AppIcon name="income" :size="20" /></span>
        <div>
          <span class="muted small"
            >Ближайшее поступление ·
            {{ daysLeft === 0 ? 'сегодня' : `через ${daysLeft} дн.` }}</span
          >
          <strong>{{ next.income.title }}</strong>
          <span class="muted small">{{ formatDate(next.income.date) }}</span>
        </div>
        <strong class="text-green">+{{ money(next.income.amount) }}</strong>
      </div>
      <dl class="forecast-next-facts">
        <div>
          <dt>Платежей до него</dt>
          <dd>{{ next.payments.length }} · {{ money(next.paymentsTotal) }}</dd>
        </div>
        <div>
          <dt>Минимальный остаток до поступления</dt>
          <dd :class="{ 'danger-text': BigInt(next.lowest) < 0n }">{{ money(next.lowest) }}</dd>
        </div>
      </dl>
      <ul v-if="next.payments.length" class="forecast-next-payments">
        <li v-for="payment in next.payments.slice(0, 4)" :key="payment.id">
          <span
            >{{ payment.title }}
            <em v-if="payment.overdue" class="danger-text">срок прошёл</em></span
          ><span>{{ formatDate(payment.date) }} · {{ money(payment.amount) }}</span>
        </li>
        <li v-if="next.payments.length > 4" class="muted small">
          и ещё {{ next.payments.length - 4 }}
        </li>
      </ul>
    </template>
    <div v-else class="forecast-next-empty">
      <AppIcon name="income" :size="24" />
      <p>
        В ближайшие {{ days }} дней поступлений не запланировано. Добавьте зарплату или другой
        доход, чтобы видеть, хватит ли денег до него.
      </p>
      <NuxtLink to="/plans" class="text-button"
        >Запланировать поступление <AppIcon name="arrow" :size="14"
      /></NuxtLink>
    </div>
  </div>
</template>
