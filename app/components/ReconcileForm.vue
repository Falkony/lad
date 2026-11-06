<script setup lang="ts">
import type { Account } from '../../shared/types'
import { accountBalance, localDate, money, toSignedMinor } from '../../shared/money'
const props = defineProps<{ account: Account; initialDate?: string }>()
const emit = defineEmits<{ saved: [] }>()
const { workspace, command, pending } = useWorkspace()
const date = ref(props.initialDate || localDate()),
  target = ref(''),
  note = ref(''),
  error = ref('')
const expected = computed(() =>
  accountBalance(
    workspace.value.accounts.find((a) => a.id === props.account.id) || props.account,
    workspace.value.transactions.filter((t) => t.date <= date.value),
  ),
)
const delta = computed(() => {
  try {
    return target.value.trim()
      ? (BigInt(toSignedMinor(target.value)) - BigInt(expected.value)).toString()
      : null
  } catch {
    return null
  }
})
useWorkspacePeriod(computed(() => date.value.slice(0, 7)))
async function save() {
  error.value = ''
  try {
    await command(
      {
        op: 'account.reconcile',
        id: props.account.id,
        data: {
          date: date.value,
          expectedBalance: expected.value,
          targetBalance: toSignedMinor(target.value),
          note: note.value,
        },
      },
      delta.value === '0'
        ? 'Остатки совпадают, корректировка не нужна'
        : 'Корректировка остатка записана',
    )
    emit('saved')
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <form class="form-stack" @submit.prevent="save">
    <label>Дата сверки<input v-model="date" type="date" required :max="localDate()" /></label>
    <div class="reconcile-comparison">
      <span>По данным «Лада» на конец дня</span><strong>{{ money(expected) }}</strong>
    </div>
    <label
      >Фактический остаток в банке, ₽<input
        v-model="target"
        inputmode="decimal"
        placeholder="0,00"
        class="amount-input"
        required
    /></label>
    <div v-if="delta !== null" class="reconcile-delta">
      <span>{{ delta === '0' ? 'Остатки совпадают' : 'Будет записана корректировка' }}</span
      ><strong>{{ BigInt(delta) > 0n ? '+' : '' }}{{ money(delta) }}</strong>
    </div>
    <label
      >Комментарий<input
        v-model="note"
        maxlength="260"
        placeholder="Например, уточнил остаток по выписке"
    /></label>
    <p class="form-hint">
      Корректировка изменит баланс с выбранной даты и не попадёт в доходы или расходы. Более поздние
      операции сохранятся.
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <button class="button primary full" :disabled="pending || delta === null">
      {{ delta === '0' ? 'Подтвердить совпадение' : 'Записать корректировку' }}
    </button>
  </form>
</template>
