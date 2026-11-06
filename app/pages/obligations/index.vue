<script setup lang="ts">
import { localDate, money } from '../../../shared/money'
import type { Obligation } from '../../../shared/types'
import { isOpen, projectPlans, addDays } from '../../../shared/planning'
import { isReceivable, obligationKinds, obligationOutlook } from '../../../shared/obligations'
const { workspace: w, command, pending } = useWorkspace()
const creating = ref(false),
  paying = ref<Obligation | null>(null)
const today = computed(() => localDate())
const formatDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
const monthYear = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
const cards = computed(() =>
  w.value.obligations.map((o) => {
    const outlook = obligationOutlook(o, w.value)
    const base = BigInt(o.openingBalance) + outlook.adjusted
    const next = outlook.plan
      ? projectPlans(w.value, o.startDate, addDays(today.value, 400)).find(
          (d) => d.planId === outlook.plan!.id && isOpen(d),
        )
      : undefined
    return {
      o,
      outlook,
      next,
      progress: base > 0n ? Number((outlook.paidPrincipal * 100n) / base) : 100,
    }
  }),
)
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n)
const debt = computed(() =>
  sum(cards.value.filter((c) => !isReceivable(c.o)).map((c) => c.outlook.remaining)),
)
const monthly = computed(() =>
  sum(
    cards.value
      .filter((c) => !isReceivable(c.o) && c.outlook.remaining > 0n)
      .map((c) => BigInt(c.o.payment)),
  ),
)
const receivable = computed(() =>
  sum(cards.value.filter((c) => isReceivable(c.o)).map((c) => c.outlook.remaining)),
)
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ПОНЯТНЫЕ ОБЯЗАТЕЛЬСТВА — СПОКОЙНЕЕ ЖИЗНЬ</div>
      <h1>Кредиты и долги<span class="title-dot">.</span></h1>
      <p>Сколько осталось, когда следующий платёж и когда долг закончится.</p>
    </div>
    <button class="button primary" @click="creating = true">
      <AppIcon name="plus" :size="18" />Добавить
    </button>
  </div>
  <div class="summary-strip">
    <div>
      <span>Осталось вернуть</span><strong>{{ money(debt, true) }}</strong>
    </div>
    <div>
      <span>Платежи в месяц</span><strong>{{ money(monthly, true) }}</strong>
    </div>
    <div>
      <span>Мне должны</span><strong class="text-green">{{ money(receivable, true) }}</strong>
    </div>
  </div>
  <div class="obligations-grid">
    <article v-for="c in cards" :key="c.o.id" class="panel obligation-card">
      <div class="obligation-top">
        <span class="account-symbol" :class="c.o.kind === 'mortgage' ? 'green' : 'sand'"
          ><AppIcon
            :name="c.o.kind === 'mortgage' ? 'home' : c.o.kind === 'receivable' ? 'income' : 'bank'"
            :size="23" /></span
        ><span class="soft-badge">{{ obligationKinds[c.o.kind] }}</span
        ><span v-if="c.outlook.remaining === 0n" class="soft-badge green">Погашено</span
        ><NuxtLink
          class="icon-button"
          :to="`/obligations/${c.o.id}`"
          :aria-label="`Подробнее: ${c.o.title}`"
        >
          <AppIcon name="more" :size="16" />
        </NuxtLink>
      </div>
      <h2>
        <NuxtLink :to="`/obligations/${c.o.id}`" class="obligation-link">{{ c.o.title }}</NuxtLink>
      </h2>
      <span class="muted small">{{
        c.o.kind === 'receivable' ? 'Ещё должны вернуть' : 'Остаток основного долга'
      }}</span
      ><strong class="obligation-amount">{{ money(c.outlook.remaining, true) }}</strong>
      <div
        class="progress-bar obligation-progress"
        role="progressbar"
        :aria-valuenow="c.progress"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="`Погашено ${c.progress}%`"
      >
        <span :style="{ width: `${c.progress}%` }" />
      </div>
      <div class="obligation-details">
        <div>
          <span>{{ c.o.kind === 'receivable' ? 'Ожидаю в месяц' : 'Платёж в месяц' }}</span
          ><strong>{{
            BigInt(c.o.payment) > 0n ? money(c.o.payment, true) : 'Без графика'
          }}</strong>
        </div>
        <div>
          <span>Следующий</span
          ><strong :class="{ 'danger-text': c.next && c.next.date < today }">{{
            c.next ? formatDate(c.next.date) : '—'
          }}</strong>
        </div>
        <div>
          <span>Погашение</span
          ><strong>{{
            c.outlook.remaining === 0n
              ? 'Завершено'
              : c.outlook.payoff
                ? monthYear(c.outlook.payoff)
                : BigInt(c.o.payment) > 0n
                  ? 'Платёж мал'
                  : '—'
          }}</strong>
        </div>
      </div>
      <button
        v-if="c.outlook.remaining > 0n"
        class="panel-bottom-link"
        :disabled="pending"
        @click="paying = c.o"
      >
        {{ c.o.kind === 'receivable' ? 'Записать возврат' : 'Внести платёж' }}
        <AppIcon name="arrow" :size="15" />
      </button>
      <NuxtLink v-else :to="`/obligations/${c.o.id}`" class="panel-bottom-link"
        >История погашений <AppIcon name="arrow" :size="15"
      /></NuxtLink>
    </article>
    <div v-if="!w.obligations.length" class="panel empty-state large">
      <AppIcon name="bank" :size="38" /><strong>Все обязательства — на виду</strong>
      <p>Добавьте кредит, ипотеку или личный долг.</p>
      <button class="button secondary" @click="creating = true">Добавить обязательство</button>
    </div>
  </div>
  <div class="note-card">
    <AppIcon name="file" :size="22" />
    <p>
      Платёж записывается расходом один раз и делится на основной долг, проценты и комиссии —
      остаток уменьшается только на основной долг. Платежи по графику сами появляются в календаре и
      прогнозе. Удалили операцию — платёж перестаёт учитываться, восстановили — снова учитывается.
    </p>
  </div>
  <AppDialog
    v-model="creating"
    title="Новое обязательство"
    description="Запишите остаток по данным банка или вашей договорённости на дату начала учёта."
    ><ObligationForm v-if="creating" @saved="creating = false"
  /></AppDialog>
  <AppDialog
    :model-value="!!paying"
    :title="paying?.kind === 'receivable' ? 'Записать возврат' : 'Внести платёж'"
    :description="paying?.title"
    @update:model-value="paying = null"
    ><ObligationPaymentForm v-if="paying" :obligation="paying" @saved="paying = null"
  /></AppDialog>
</template>
