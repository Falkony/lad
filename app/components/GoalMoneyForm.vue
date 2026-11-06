<script setup lang="ts">
import type { Goal } from '../../shared/types'
import { fundingOf, goalAllocations } from '../../shared/goals'
import { localDate, toMinor, money } from '../../shared/money'
const props = defineProps<{ goal: Goal }>(),
  emit = defineEmits<{ saved: [] }>()
const { workspace: w, command, pending } = useWorkspace()
const action = ref('reserve'),
  amount = ref(''),
  accountId = ref(''),
  date = ref(localDate()),
  note = ref(''),
  mode = ref('create'),
  transactionId = ref(''),
  error = ref(''),
  revision = ref(w.value.revision)
const allocations = computed(() => [...goalAllocations(props.goal)]),
  funding = computed(() => fundingOf(props.goal))
const choices = computed(() =>
  w.value.transactions.filter(
    (t) => t.kind === (action.value === 'purchase' ? 'expense' : 'income'),
  ),
)
async function save() {
  error.value = ''
  try {
    const common = { id: props.goal.id, expectedRevision: revision.value }
    const amountMinor = toMinor(amount.value)
    await command(
      ['reserve', 'release'].includes(action.value)
        ? {
            op: 'goal.allocate',
            ...common,
            accountId: accountId.value,
            amount: amountMinor,
            date: date.value,
            action: action.value,
            note: note.value,
          }
        : {
            op: action.value === 'purchase' ? 'goal.purchase' : 'goal.refund',
            ...common,
            mode: mode.value,
            accountId: accountId.value || undefined,
            transactionId: transactionId.value || undefined,
            date: date.value,
            amount: amountMinor,
          },
      'История цели обновлена',
    )
    emit('saved')
  } catch (e: any) {
    error.value = e.message
    revision.value = w.value.revision
  }
}
async function cancel() {
  try {
    await command(
      { op: 'goal.cancel', id: props.goal.id, expectedRevision: revision.value },
      'Цель отменена, резервы освобождены',
    )
    emit('saved')
  } catch (e: any) {
    error.value = e.message
    revision.value = w.value.revision
  }
}
</script>
<template>
  <form class="form-stack" @submit.prevent="save">
    <p>Резерв не меняет остаток счёта. Для перемещения денег запишите перевод в операциях.</p>
    <p v-for="[id, value] in allocations" :key="id">
      {{ w.accounts.find((a) => a.id === id)?.name }}: {{ money(value.toString()) }}
    </p>
    <p v-if="funding.unassigned !== '0'" class="form-hint">
      Без привязки к счетам: {{ money(funding.unassigned) }}. Эта оценка не защищена резервом;
      резервирование привязывает её к деньгам.
    </p>
    <label
      >Действие<select v-model="action">
        <option value="reserve">Зарезервировать</option>
        <option value="release">Изъять из резерва</option>
        <option value="purchase">Записать покупку</option>
        <option value="refund">Возврат покупки</option>
      </select></label
    >
    <label v-if="['purchase', 'refund'].includes(action)"
      >Операция<select v-model="mode">
        <option value="create">Создать</option>
        <option value="link">Связать существующую</option>
      </select></label
    >
    <label v-if="mode === 'link' && ['purchase', 'refund'].includes(action)"
      >Выберите операцию<select v-model="transactionId" required>
        <option value="" disabled>Выберите</option>
        <option v-for="t in choices" :key="t.id" :value="t.id">
          {{ t.date }} · {{ t.description || t.category }} · {{ money(t.amount) }}
        </option>
      </select></label
    >
    <label v-else
      >Счёт<select v-model="accountId" required>
        <option value="" disabled>Выберите</option>
        <option
          v-for="a in w.accounts.filter(
            (a) => !a.archived && (!['reserve', 'release'].includes(action) || a.kind !== 'credit'),
          )"
          :key="a.id"
          :value="a.id"
        >
          {{ a.name }}
        </option>
      </select></label
    >
    <label>Сумма, ₽<input v-model="amount" inputmode="decimal" required /></label>
    <label>Дата<input v-model="date" type="date" :max="localDate()" required /></label>
    <label>Комментарий<input v-model="note" maxlength="300" /></label>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="dialog-actions">
      <button type="button" class="button ghost danger-text" :disabled="pending" @click="cancel">
        Отменить цель</button
      ><button class="button primary" :disabled="pending">Сохранить</button>
    </div>
  </form>
  <details class="form-stack">
    <summary>История накоплений и покупок</summary>
    <p v-for="e in funding.entries" :key="e.id">
      {{ e.date }} · {{ w.accounts.find((a) => a.id === e.accountId)?.name }} ·
      {{ money(e.amount) }} · {{ e.note }}
    </p>
    <p v-for="p in funding.purchases" :key="p.transactionId">
      Покупка:
      <NuxtLink :to="`/transactions?transactionId=${p.transactionId}`">операция</NuxtLink> ·
      возвратов: {{ p.refundIds.length }}
    </p>
  </details>
</template>
