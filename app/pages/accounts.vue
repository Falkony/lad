<script setup lang="ts">
import { forecast } from '../../shared/forecast'
import { creditState } from '../../shared/credit'
import { money, localDate } from '../../shared/money'
const { workspace: w } = useWorkspace()
const cards = computed(() =>
  w.value.accounts
    .filter((a) => a.kind === 'credit' && !a.archived)
    .map((a) => ({
      account: a,
      state: creditState(a, w.value.transactions),
      forecast: forecast(
        {
          ...w.value,
          accounts: w.value.accounts.map((x) => ({ ...x, inForecast: x.id === a.id })),
        },
        localDate(),
        90,
      ).accounts[0]!,
    })),
)
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">КАЖДОМУ СЧЁТУ — СВОЁ МЕСТО</div>
      <h1>Мои счета<span class="title-dot">.</span></h1>
      <p>Карты, наличные и накопления. Настройки всегда под рукой.</p>
    </div>
  </div>
  <AccountSection full />
  <section v-if="cards.length" class="panel form-stack">
    <h2>Кредитные карты · прогноз на 90 дней</h2>
    <article v-for="card in cards" :key="card.account.id" class="summary-strip">
      <div>
        <span>{{ card.account.name }} · долг</span
        ><strong>{{ money(card.state.debt.toString()) }}</strong>
      </div>
      <div>
        <span>Доступно из лимита</span><strong>{{ money(card.state.available.toString()) }}</strong>
      </div>
      <div>
        <span>Минимум доступного</span
        ><strong>{{ money(card.forecast.minAvailable || '0') }}</strong
        ><small>{{ card.forecast.minDate }}</small>
      </div>
      <div>
        <span>Выход за лимит</span
        ><strong>{{ card.forecast.deficitDate || 'Не ожидается' }}</strong>
      </div>
    </article>
    <p class="form-hint">
      Покупки уменьшают остаток, погашения возвращают доступный лимит. В прогнозе только введённые
      планы; условия банка и льготный период сверяйте с выпиской.
    </p>
  </section>
</template>
