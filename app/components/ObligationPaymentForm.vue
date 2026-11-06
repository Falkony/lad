<script setup lang="ts">
// A repayment: one transaction split into principal, interest and fees. For a new payment the
// user picks the scheduled date it settles or makes an early repayment, and either records a new
// transaction or links one that is already recorded (an imported bank statement, for example).
import type { Obligation, ObligationEntry } from '../../shared/types'
import { localDate, money, toMajor, toMinor } from '../../shared/money'
import { isOpen, projectPlans, addDays } from '../../shared/planning'
import {
  annuityPayment,
  isReceivable,
  monthlyInterest,
  obligationDirection,
  obligationOutlook,
  paymentSchedule,
} from '../../shared/obligations'
const props = defineProps<{
  obligation: Obligation
  entry?: ObligationEntry | null
  /** The scheduled date to settle, when the form is opened from it. */
  dueDate?: string | null
}>()
const emit = defineEmits<{ saved: [] }>()
const { workspace: w, command, pending } = useWorkspace()
const today = localDate()
const formatDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
const monthYear = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })

const outlook = computed(() => obligationOutlook(props.obligation, w.value))
const receivable = computed(() => isReceivable(props.obligation))
/** Open scheduled dates up to two months ahead: overdue ones first. */
const openDates = computed(() => {
  const plan = outlook.value.plan
  if (!plan) return []
  return projectPlans(w.value, props.obligation.startDate, addDays(today, 62)).filter(
    (d) => d.planId === plan.id && isOpen(d),
  )
})
const form = reactive({
  kind: 'scheduled' as 'scheduled' | 'early',
  dueDate: '',
  early: 'term' as 'term' | 'payment',
  mode: 'create' as 'create' | 'link',
  accountId: '',
  transactionId: '',
  date: today,
  total: '',
  interest: '',
  fees: '',
  note: '',
})
const error = ref(''),
  revision = ref(''),
  search = ref('')
function reset() {
  error.value = ''
  revision.value = w.value.revision
  search.value = ''
  const e = props.entry
  if (e) {
    Object.assign(form, {
      kind: e.early === 'none' ? 'scheduled' : 'early',
      date: e.date,
      total: toMajor((BigInt(e.principal) + BigInt(e.interest) + BigInt(e.fees)).toString()),
      interest: toMajor(e.interest),
      fees: toMajor(e.fees),
      note: e.note,
    })
    return
  }
  const due = openDates.value.find((d) => d.dueDate === props.dueDate) || openDates.value[0]
  const scheduled = !!due && BigInt(props.obligation.payment) > 0n
  Object.assign(form, {
    kind: scheduled ? 'scheduled' : 'early',
    dueDate: due?.dueDate || '',
    early: 'term',
    mode: 'create',
    accountId:
      w.value.accounts.find((a) => !a.archived && a.id === props.obligation.accountId)?.id ||
      w.value.accounts.find((a) => !a.archived)?.id ||
      '',
    transactionId: '',
    date: due && due.date < today ? due.date : today,
    total: scheduled ? toMajor(due!.amount) : '',
    fees: '',
    note: '',
  })
  suggestInterest()
}
/** This month's interest on the balance; an early repayment usually goes to the principal. */
function suggestInterest() {
  form.interest =
    form.kind === 'early'
      ? ''
      : toMajor(monthlyInterest(outlook.value.remaining, props.obligation.rate).toString())
}
watch(() => [props.obligation.id, props.entry?.id, props.dueDate], reset, { immediate: true })
watch(
  () => form.dueDate,
  (value) => {
    const due = openDates.value.find((d) => d.dueDate === value)
    if (due && !props.entry) {
      form.total = toMajor(due.amount)
      form.date = due.date < today ? due.date : today
    }
  },
)
watch(
  () => form.kind,
  () => {
    if (!props.entry) suggestInterest()
  },
)

const minor = (value: string) => {
  try {
    return BigInt(toMinor(value || '0'))
  } catch {
    return null
  }
}
const principal = computed(() => {
  const total = minor(form.total),
    interest = minor(form.interest),
    fees = minor(form.fees)
  return total === null || interest === null || fees === null ? null : total - interest - fees
})
/** The balance before this payment: an edited payment no longer counts against itself. */
const balance = computed(() =>
  props.entry ? outlook.value.remaining + BigInt(props.entry.principal) : outlook.value.remaining,
)
const after = computed(() => (principal.value === null ? null : balance.value - principal.value))

const direction = computed(() => obligationDirection(props.obligation))
const linked = computed(
  () =>
    new Set([
      ...w.value.obligationEntries.map((e) => e.transactionId),
      ...w.value.planOccurrences.map((o) => o.transactionId),
    ]),
)
const candidates = computed(() =>
  w.value.transactions
    .filter(
      (t) =>
        t.kind === direction.value &&
        !linked.value.has(t.id) &&
        t.date >= props.obligation.startDate &&
        `${t.description} ${t.category} ${t.date} ${money(t.amount)}`
          .toLocaleLowerCase('ru')
          .includes(search.value.toLocaleLowerCase('ru')),
    )
    .slice(0, 50),
)
watch(
  () => form.transactionId,
  (id) => {
    const t = w.value.transactions.find((t) => t.id === id)
    if (t) {
      form.total = toMajor(t.amount)
      form.date = t.date
    }
  },
)

/** What an early repayment changes: the payoff date or the monthly payment. */
const preview = computed(() => {
  if (form.kind !== 'early' || principal.value === null || principal.value <= 0n) return null
  if (after.value === null || after.value <= 0n) return null
  const o = props.obligation,
    payment = BigInt(o.payment)
  if (payment <= 0n) return null
  const now = paymentSchedule(
    outlook.value.remaining,
    o.rate,
    payment,
    outlook.value.firstOpen,
    o.dueDay,
  )
  if (!now.complete) return null
  const shorter = paymentSchedule(after.value, o.rate, payment, outlook.value.firstOpen, o.dueDay)
  return {
    months: now.rows.length,
    payoffNow: now.rows.at(-1)!.date,
    payoffShorter: shorter.rows.at(-1)?.date || null,
    savedMonths: now.rows.length - shorter.rows.length,
    lowered: annuityPayment(after.value, o.rate, now.rows.length),
  }
})

async function save() {
  error.value = ''
  try {
    if (principal.value === null) throw new Error('Проверьте суммы')
    if (principal.value < 0n)
      throw new Error('Проценты и комиссии не могут быть больше суммы платежа')
    const split = {
      principal: principal.value.toString(),
      interest: toMinor(form.interest || '0'),
      fees: toMinor(form.fees || '0'),
    }
    if (props.entry) {
      await command(
        {
          op: 'obligation.payment.update',
          id: props.entry.id,
          expectedRevision: revision.value,
          date: form.date,
          ...split,
          note: form.note,
        },
        'Платёж изменён',
      )
    } else {
      await command(
        {
          op: 'obligation.pay',
          obligationId: props.obligation.id,
          expectedRevision: revision.value,
          date: form.date,
          ...split,
          mode: form.mode,
          ...(form.mode === 'create'
            ? { accountId: form.accountId }
            : { transactionId: form.transactionId }),
          dueDate: form.kind === 'scheduled' ? form.dueDate || null : null,
          early:
            form.kind === 'early' && BigInt(props.obligation.payment) > 0n ? form.early : 'none',
          note: form.note,
        },
        receivable.value ? 'Возврат записан в доходы' : 'Платёж записан',
      )
    }
    emit('saved')
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <form class="form-stack" @submit.prevent="save">
    <div v-if="!entry" class="segmented">
      <button
        type="button"
        :class="{ selected: form.kind === 'scheduled' }"
        :disabled="!openDates.length"
        @click="form.kind = 'scheduled'"
      >
        По графику</button
      ><button
        type="button"
        :class="{ selected: form.kind === 'early' }"
        @click="form.kind = 'early'"
      >
        {{ receivable ? 'Вне графика' : 'Досрочно' }}
      </button>
    </div>
    <label v-if="!entry && form.kind === 'scheduled'"
      >Дата графика<select v-model="form.dueDate" required>
        <option v-for="d in openDates" :key="d.dueDate" :value="d.dueDate">
          {{ formatDate(d.date) }} · {{ money(d.amount)
          }}{{ d.date < today ? ' · срок прошёл' : '' }}
        </option>
      </select></label
    >
    <div v-if="!entry" class="segmented">
      <button
        type="button"
        :class="{ selected: form.mode === 'create' }"
        @click="form.mode = 'create'"
      >
        Новая операция</button
      ><button
        type="button"
        :class="{ selected: form.mode === 'link' }"
        @click="form.mode = 'link'"
      >
        Уже записана
      </button>
    </div>
    <template v-if="!entry && form.mode === 'link'">
      <label
        >Найти {{ receivable ? 'доход' : 'расход'
        }}<input v-model="search" placeholder="Описание, дата или сумма"
      /></label>
      <label
        >Записанная операция<select v-model="form.transactionId" required>
          <option value="" disabled>Выберите операцию</option>
          <option v-for="t in candidates" :key="t.id" :value="t.id">
            {{ t.date }} · {{ t.description || t.category }} · {{ money(t.amount) }}
          </option>
        </select></label
      >
      <p v-if="!candidates.length" class="form-hint">
        Подходящих операций нет: нужны {{ receivable ? 'доходы' : 'расходы' }}, не связанные с
        другим планом или платежом и не раньше начала учёта.
      </p>
    </template>
    <div class="form-row">
      <label
        >Дата платежа<input
          v-model="form.date"
          type="date"
          :min="obligation.startDate"
          :max="today"
          :disabled="!entry && form.mode === 'link'"
          required /></label
      ><label v-if="entry || form.mode === 'create'"
        >Сумма, ₽<input v-model="form.total" inputmode="decimal" required placeholder="0,00"
      /></label>
      <label v-if="!entry && form.mode === 'create'" class="full-row"
        >{{ receivable ? 'Счёт зачисления' : 'Счёт списания'
        }}<select v-model="form.accountId" required>
          <option v-for="a in w.accounts.filter((a) => !a.archived)" :key="a.id" :value="a.id">
            {{ a.name }}
          </option>
        </select></label
      >
    </div>
    <div class="form-row">
      <label
        >Проценты, ₽<input v-model="form.interest" inputmode="decimal" placeholder="0,00" /></label
      ><label
        >Комиссии, ₽<input v-model="form.fees" inputmode="decimal" placeholder="0,00"
      /></label>
    </div>
    <div class="payment-split" aria-live="polite">
      <div>
        <span>В счёт основного долга</span
        ><strong :class="{ 'danger-text': principal !== null && principal < 0n }">{{
          principal === null ? '—' : money(principal)
        }}</strong>
      </div>
      <div>
        <span>Останется</span
        ><strong :class="{ 'danger-text': after !== null && after < 0n }">{{
          after === null ? '—' : money(after)
        }}</strong>
      </div>
    </div>
    <p v-if="after !== null && after < 0n" class="form-error">
      Это больше остатка долга на {{ money(-after) }}. Отнесите лишнее на проценты или комиссии,
      если банк так их списал, или уменьшите сумму.
    </p>
    <p v-else class="form-hint">
      Проценты подставлены расчётом за месяц: остаток × ставка / 12. Сверьте их с выпиской банка —
      от этого зависит, насколько уменьшится долг.
    </p>
    <fieldset v-if="!entry && form.kind === 'early' && preview" class="early-choice">
      <legend>После досрочного погашения</legend>
      <label class="checkbox-row"
        ><input v-model="form.early" type="radio" value="term" /><span
          >Сократить срок<small
            >Платёж остаётся {{ money(obligation.payment) }}; погашение —
            {{ monthYear(preview.payoffShorter || preview.payoffNow)
            }}{{
              preview.savedMonths
                ? `, на ${preview.savedMonths} мес. раньше`
                : ', в том же месяце: суммы мало, чтобы убрать целый платёж'
            }}.</small
          ></span
        ></label
      >
      <label class="checkbox-row"
        ><input v-model="form.early" type="radio" value="payment" /><span
          >Уменьшить платёж<small
            >Срок прежний — {{ monthYear(preview.payoffNow) }}; платёж станет
            {{ money(preview.lowered) }} вместо {{ money(obligation.payment) }}.</small
          ></span
        ></label
      >
      <p class="form-hint">Выберите то же, что указали в заявлении банку.</p>
    </fieldset>
    <label
      >Заметка<input v-model="form.note" maxlength="300" placeholder="Например, номер платежа"
    /></label>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <button class="button primary full" :disabled="pending">
      {{ entry ? 'Сохранить платёж' : receivable ? 'Записать возврат' : 'Записать платёж' }}
    </button>
  </form>
</template>
