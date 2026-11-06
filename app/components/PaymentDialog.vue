<script setup lang="ts">
import type { ProjectedPayment } from '../../shared/planning-types'
import { money, toMinor, toMajor, localDate } from '../../shared/money'
const payment = defineModel<ProjectedPayment | null>({ default: null })
const { workspace: w, command, pending, notify } = useWorkspace()
const mode = ref('create'),
  amount = ref(''),
  accountId = ref(''),
  date = ref(localDate()),
  transactionId = ref(''),
  search = ref(''),
  revision = ref(''),
  error = ref('')
watch(payment, (value) => {
  if (!value) return
  mode.value = 'create'
  amount.value = toMajor(value.amount)
  accountId.value =
    w.value.accounts.find((a) => !a.archived && a.id === value.accountId)?.id ||
    w.value.accounts.find((a) => !a.archived)?.id ||
    ''
  date.value = localDate()
  transactionId.value = ''
  search.value = ''
  revision.value = w.value.revision
  error.value = ''
})
const available = computed(() =>
  w.value.transactions.filter(
    (t) =>
      t.kind === 'expense' &&
      !w.value.paymentOccurrences.some((p) => p.transactionId === t.id) &&
      `${t.description} ${t.category} ${t.date} ${money(t.amount)}`
        .toLocaleLowerCase('ru')
        .includes(search.value.toLocaleLowerCase('ru')),
  ),
)
const linked = computed(() => w.value.transactions.find((t) => t.id === transactionId.value))
async function save() {
  if (!payment.value) return
  error.value = ''
  try {
    const result = await command({
      op: 'payment.pay',
      recurringId: payment.value.recurringId,
      dueDate: payment.value.dueDate,
      expectedRevision: revision.value,
      mode: mode.value,
      date: date.value,
      ...(mode.value === 'create'
        ? { amount: toMinor(amount.value), accountId: accountId.value }
        : { transactionId: transactionId.value }),
    })
    notify(
      result.alreadyPaid
        ? 'Этот платёж уже был записан'
        : mode.value === 'link'
          ? 'Существующий расход связан с платежом'
          : 'Оплата записана в расходы',
    )
    payment.value = null
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <AppDialog
    :model-value="!!payment"
    title="Записать оплату"
    :description="
      payment
        ? `${payment.title} · срок ${new Date(payment.dueDate + 'T12:00:00').toLocaleDateString('ru-RU')}`
        : ''
    "
    @update:model-value="payment = null"
    ><form class="form-stack" @submit.prevent="save">
      <div class="reconcile-comparison">
        <span>Плановая сумма</span><strong>{{ money(payment?.amount || '0') }}</strong>
      </div>
      <div class="segmented">
        <button type="button" :class="{ selected: mode === 'create' }" @click="mode = 'create'">
          Новый расход</button
        ><button type="button" :class="{ selected: mode === 'link' }" @click="mode = 'link'">
          Уже записан
        </button>
      </div>
      <template v-if="mode === 'create'"
        ><label
          >Фактически оплачено, ₽<input
            v-model="amount"
            class="amount-input"
            inputmode="decimal"
            required /></label
        ><label
          >Счёт списания<select v-model="accountId" required>
            <option value="" disabled>Выберите счёт</option>
            <option
              v-for="account in w.accounts.filter((a) => !a.archived)"
              :key="account.id"
              :value="account.id"
            >
              {{ account.name }}
            </option>
          </select></label
        ><label>Дата оплаты<input v-model="date" type="date" required :max="localDate()" /></label>
        <p v-if="!w.accounts.some((a) => !a.archived)" class="form-hint">
          Для записи оплаты добавьте действующий счёт.
        </p></template
      ><template v-else
        ><label
          >Поиск расхода<input v-model="search" placeholder="Название, дата или сумма" /></label
        ><label
          >Записанный расход<select v-model="transactionId" required>
            <option value="" disabled>Выберите операцию</option>
            <option v-for="t in available.slice(0, 100)" :key="t.id" :value="t.id">
              {{ t.date }} · {{ t.description || t.category }} · {{ money(t.amount) }}
            </option>
          </select></label
        >
        <p v-if="linked" class="form-hint">
          {{ linked.category }} · {{ w.accounts.find((a) => a.id === linked?.accountId)?.name }}.
          Новый расход не создаётся.
        </p>
        <p v-if="available.length > 100" class="form-hint">
          Уточните поиск: показаны первые 100 расходов.
        </p>
        <p v-if="!available.length" class="form-hint">
          Подходящих несвязанных расходов нет. Измените поиск или создайте новый расход.
        </p></template
      >
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button
        class="button primary full"
        :disabled="pending || (mode === 'create' ? !accountId : !transactionId)"
      >
        {{
          pending
            ? 'Сохраняем…'
            : mode === 'create'
              ? 'Записать расход и оплату'
              : 'Связать с этим расходом'
        }}
      </button>
    </form></AppDialog
  >
</template>
