<script setup lang="ts">
import type { ProjectedOccurrence } from '../../shared/planning-types'
import { money, toMinor, toMajor, localDate } from '../../shared/money'
const item = defineModel<ProjectedOccurrence | null>({ default: null })
const { workspace: w, command, pending, notify } = useWorkspace()
const mode = ref('create'),
  amount = ref(''),
  accountId = ref(''),
  date = ref(localDate()),
  transactionId = ref(''),
  search = ref(''),
  revision = ref(''),
  error = ref('')
const income = computed(() => item.value?.direction === 'income')
const credit = computed(() => item.value?.source === 'credit')
/** A date of an obligation schedule: the payment is split into principal and interest. */
const obligation = computed(() => {
  const plan = w.value.plans.find((p) => p.id === item.value?.planId)
  return plan?.source === 'obligation'
    ? w.value.obligations.find((o) => o.id === plan.sourceId)
    : undefined
})
watch(item, (value) => {
  if (!value) return
  mode.value = 'create'
  amount.value = toMajor(value.amount)
  accountId.value =
    w.value.accounts.find((a) => !a.archived && a.id === value.accountId)?.id ||
    w.value.accounts.find((a) => !a.archived)?.id ||
    ''
  // A date planned in the past is usually confirmed for that day; a future one is early.
  date.value = value.date < localDate() ? value.date : localDate()
  transactionId.value = ''
  search.value = ''
  revision.value = w.value.revision
  error.value = ''
})
const available = computed(() =>
  w.value.transactions.filter(
    (t) =>
      t.kind === (credit.value ? 'transfer' : item.value?.direction) &&
      (!credit.value || t.toAccountId === item.value?.creditAccountId) &&
      !w.value.planOccurrences.some((p) => p.transactionId === t.id) &&
      !w.value.obligationEntries.some((e) => e.transactionId === t.id) &&
      `${t.description} ${t.category} ${t.date} ${money(t.amount)}`
        .toLocaleLowerCase('ru')
        .includes(search.value.toLocaleLowerCase('ru')),
  ),
)
const linked = computed(() => w.value.transactions.find((t) => t.id === transactionId.value))
const noun = computed(() => (credit.value ? 'перевод' : income.value ? 'доход' : 'расход'))
async function save() {
  if (!item.value) return
  error.value = ''
  try {
    const result = await command({
      op: 'occurrence.confirm',
      planId: item.value.planId,
      dueDate: item.value.dueDate,
      expectedRevision: revision.value,
      mode: mode.value,
      date: date.value,
      ...(mode.value === 'create'
        ? { amount: toMinor(amount.value), accountId: accountId.value }
        : { transactionId: transactionId.value }),
    })
    notify(
      result.alreadyPaid
        ? 'Эта дата уже была подтверждена'
        : mode.value === 'link'
          ? `Существующий ${noun.value} связан с планом`
          : credit.value
            ? 'Погашение записано переводом на карту'
            : income.value
              ? 'Поступление записано в доходы'
              : 'Оплата записана в расходы',
    )
    item.value = null
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <AppDialog
    :model-value="!!item"
    :title="income ? 'Записать поступление' : 'Записать оплату'"
    :description="
      item
        ? `${item.title} · срок ${new Date(item.date + 'T12:00:00').toLocaleDateString('ru-RU')}`
        : ''
    "
    @update:model-value="item = null"
    ><form class="form-stack" @submit.prevent="save">
      <div class="reconcile-comparison">
        <span>Плановая сумма</span><strong>{{ money(item?.amount || '0') }}</strong>
      </div>
      <div class="segmented">
        <button type="button" :class="{ selected: mode === 'create' }" @click="mode = 'create'">
          {{ credit ? 'Перевод на карту' : income ? 'Новый доход' : 'Новый расход' }}</button
        ><button type="button" :class="{ selected: mode === 'link' }" @click="mode = 'link'">
          Уже записан
        </button>
      </div>
      <template v-if="mode === 'create'"
        ><label
          >{{ income ? 'Фактически получено, ₽' : 'Фактически оплачено, ₽'
          }}<input v-model="amount" class="amount-input" inputmode="decimal" required /></label
        ><label
          >{{ income ? 'Счёт зачисления' : 'Счёт списания'
          }}<select v-model="accountId" required>
            <option value="" disabled>Выберите счёт</option>
            <option
              v-for="account in w.accounts.filter(
                (a) => !a.archived && (!credit || a.kind !== 'credit'),
              )"
              :key="account.id"
              :value="account.id"
            >
              {{ account.name }}
            </option>
          </select></label
        ><label
          >{{ income ? 'Дата поступления' : 'Дата оплаты'
          }}<input v-model="date" type="date" required :max="localDate()"
        /></label>
        <p v-if="!w.accounts.some((a) => !a.archived)" class="form-hint">
          Для подтверждения добавьте действующий счёт.
        </p></template
      ><template v-else
        ><label
          >Поиск {{ income ? 'дохода' : 'расхода'
          }}<input v-model="search" placeholder="Название, дата или сумма" /></label
        ><label
          >Записанная операция<select v-model="transactionId" required>
            <option value="" disabled>Выберите операцию</option>
            <option v-for="t in available.slice(0, 100)" :key="t.id" :value="t.id">
              {{ t.date }} · {{ t.description || t.category }} · {{ money(t.amount) }}
            </option>
          </select></label
        >
        <p v-if="linked" class="form-hint">
          {{ linked.category }} · {{ w.accounts.find((a) => a.id === linked?.accountId)?.name }}.
          Новая операция не создаётся.
        </p>
        <p v-if="available.length > 100" class="form-hint">
          Уточните поиск: показаны первые 100 операций.
        </p>
        <p v-if="!available.length" class="form-hint">
          Подходящих несвязанных операций нет. Измените поиск или запишите новую операцию.
        </p></template
      >
      <p v-if="obligation" class="form-hint">
        Платёж по обязательству: проценты за месяц вычтутся по расчёту, остальное уменьшит долг.
        Точное разделение по выписке можно указать в
        <NuxtLink :to="`/obligations/${obligation.id}`">«{{ obligation.title }}»</NuxtLink>.
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button
        class="button primary full"
        :disabled="pending || (mode === 'create' ? !accountId : !transactionId)"
      >
        {{
          pending
            ? 'Сохраняем…'
            : mode === 'create'
              ? income
                ? 'Записать доход и поступление'
                : 'Записать расход и оплату'
              : `Связать с этим ${income ? 'доходом' : 'расходом'}`
        }}
      </button>
    </form></AppDialog
  >
</template>
