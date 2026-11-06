<script setup lang="ts">
import { categories, type Transaction } from '../../shared/types'
import { toMinor, toMajor, localDate } from '../../shared/money'
const props = defineProps<{ transaction?: Transaction | null }>()
const emit = defineEmits<{ saved: [] }>()
const { workspace, command, pending } = useWorkspace()
const kind = ref<'expense' | 'income' | 'transfer'>('expense')
const amount = ref(''),
  description = ref(''),
  category = ref('Продукты'),
  date = ref(localDate())
const accountId = ref(workspace.value.accounts[0]?.id || ''),
  toAccountId = ref(''),
  error = ref('')
watch(
  () => props.transaction,
  (t) => {
    kind.value = t && t.kind !== 'adjustment' ? t.kind : 'expense'
    amount.value = t ? toMajor(t.amount) : ''
    description.value = t?.description || ''
    category.value = t?.category || 'Продукты'
    date.value = t?.date || localDate()
    accountId.value = t?.accountId || workspace.value.accounts.find((a) => !a.archived)?.id || ''
    toAccountId.value = t?.toAccountId || ''
    error.value = ''
  },
  { immediate: true },
)
const availableAccounts = computed(() =>
  workspace.value.accounts.filter(
    (a) =>
      !a.archived ||
      (props.transaction &&
        [props.transaction.accountId, props.transaction.toAccountId].includes(a.id)),
  ),
)
const availableCategories = computed(() => [
  ...new Set([
    ...categories,
    ...workspace.value.transactions.map((t) => t.category),
    ...(props.transaction ? [props.transaction.category] : []),
  ]),
])
async function submit() {
  error.value = ''
  try {
    await command(
      {
        op: props.transaction ? 'transaction.update' : 'transaction.create',
        ...(props.transaction ? { id: props.transaction.id } : {}),
        data: {
          kind: kind.value,
          amount: toMinor(amount.value),
          accountId: accountId.value,
          toAccountId: kind.value === 'transfer' ? toAccountId.value : null,
          category: kind.value === 'transfer' ? 'Перевод' : category.value,
          description: description.value,
          date: date.value,
        },
      },
      props.transaction ? 'Операция обновлена' : 'Операция добавлена',
    )
    emit('saved')
  } catch (err: any) {
    error.value = err.message
  }
}
</script>
<template>
  <form class="form-stack" @submit.prevent="submit">
    <div class="segmented">
      <button
        v-for="item in [
          { value: 'expense', label: 'Расход' },
          { value: 'income', label: 'Доход' },
          { value: 'transfer', label: 'Перевод' },
        ]"
        :key="item.value"
        type="button"
        :class="{ selected: kind === item.value }"
        @click="kind = item.value as typeof kind"
      >
        {{ item.label }}
      </button>
    </div>
    <label
      >Сумма, ₽<input
        v-model="amount"
        class="amount-input"
        inputmode="decimal"
        placeholder="0,00"
        required
        autofocus
    /></label>
    <div class="form-row">
      <label
        >Счёт<select v-model="accountId" required>
          <option value="" disabled>Выберите счёт</option>
          <option v-for="account in availableAccounts" :key="account.id" :value="account.id">
            {{ account.name }}{{ account.archived ? ' (архив)' : '' }}
          </option>
        </select></label
      ><label v-if="kind !== 'transfer'"
        >Категория<select v-model="category">
          <option v-for="cat in availableCategories" :key="cat">{{ cat }}</option>
        </select></label
      ><label v-else
        >Куда перевести<select v-model="toAccountId" required>
          <option value="" disabled>Выберите счёт</option>
          <option
            v-for="account in availableAccounts.filter((x) => x.id !== accountId)"
            :key="account.id"
            :value="account.id"
          >
            {{ account.name }}{{ account.archived ? ' (архив)' : '' }}
          </option>
        </select></label
      >
    </div>
    <label
      >Описание<input
        v-model="description"
        placeholder="На что потратили или откуда получили"
        maxlength="300" /></label
    ><label>Дата<input v-model="date" type="date" :max="localDate()" required /></label>
    <p v-if="!availableAccounts.length" class="form-hint">
      Сначала добавьте счёт в разделе «Обзор».
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <button class="button primary full" :disabled="pending || !availableAccounts.length">
      <AppIcon :name="transaction ? 'check' : 'plus'" :size="17" />{{
        pending ? 'Сохраняем…' : transaction ? 'Сохранить изменения' : 'Добавить операцию'
      }}
    </button>
  </form>
</template>
