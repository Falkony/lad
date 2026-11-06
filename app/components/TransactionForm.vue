<script setup lang="ts">
import type { Transaction } from '../../shared/types'
const { categoryNames: categories } = useCategories()
import { toMinor, toMajor, localDate } from '../../shared/money'
const props = defineProps<{ transaction?: Transaction | null }>()
const emit = defineEmits<{ saved: [] }>()
const { workspace, command, pending } = useWorkspace()
const kind = ref<'expense' | 'income' | 'transfer'>('expense')
const splits = ref<{ categoryId: string; amount: string }[]>([]),
  refundOf = ref(''),
  purchaseSearch = ref('')
const { data: purchases } = await useFetch('/api/transactions', {
  query: computed(() => ({ kind: 'expense', limit: 30, search: purchaseSearch.value })),
  default: () => ({
    rows: [],
    count: 0,
    income: '0',
    expense: '0',
    page: 1,
    limit: 30,
    revision: '0',
  }),
})
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
    splits.value = (t?.splits || []).map((p) => ({
      categoryId: p.categoryId,
      amount: toMajor(p.amount),
    }))
    refundOf.value = t?.refundOf || ''
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
    ...categories.value,
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
          splits:
            kind.value === 'expense'
              ? splits.value.map((p) => ({ ...p, amount: toMinor(p.amount) }))
              : [],
          refundOf: kind.value === 'income' ? refundOf.value || null : null,
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
    <details v-if="kind === 'expense'" class="form-stack">
      <summary>Разделить расход по категориям</summary>
      <div v-for="(part, index) in splits" :key="index" class="form-row">
        <label
          >Категория<select v-model="part.categoryId" required>
            <option value="" disabled>Выберите</option>
            <option
              v-for="c in (workspace.categories || []).filter(
                (c) => !c.archived || c.id === part.categoryId,
              )"
              :key="c.id"
              :value="c.id"
            >
              {{ c.name }}
            </option>
          </select></label
        ><label>Сумма, ₽<input v-model="part.amount" inputmode="decimal" required /></label
        ><button type="button" class="button ghost" @click="splits.splice(index, 1)">Убрать</button>
      </div>
      <button
        type="button"
        class="button secondary"
        @click="splits.push({ categoryId: '', amount: '' })"
      >
        Добавить категорию
      </button>
      <p class="form-hint">Сумма частей должна равняться сумме операции.</p>
    </details>
    <details v-if="kind === 'income'" class="form-stack">
      <summary>Это возврат покупки</summary>
      <label>Поиск покупки<input v-model="purchaseSearch" placeholder="Описание покупки" /></label
      ><label
        >Исходный расход<select v-model="refundOf">
          <option value="">Обычный доход</option>
          <option
            v-if="refundOf && !purchases.rows.some((t) => t.id === refundOf)"
            :value="refundOf"
          >
            Ранее выбранная покупка
          </option>
          <option v-for="t in purchases.rows" :key="t.id" :value="t.id">
            {{ t.date }} · {{ t.description || t.category }} · {{ toMajor(t.amount) }} ₽
          </option>
        </select></label
      >
      <p class="form-hint">
        Возврат уменьшит расходы в месяце возврата и не увеличит доходы. Разделение по категориям
        определяется исходной покупкой.
      </p>
    </details>
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
