<script setup lang="ts">
import type { RecurringPayment } from '../../shared/planning-types'
import { categories } from '../../shared/types'
import { localDate, toMinor, toMajor } from '../../shared/money'
const props = defineProps<{
  rule?: RecurringPayment | null
  initial?: { title?: string; amount?: string; startDate?: string }
}>()
const emit = defineEmits<{ saved: [] }>()
const { workspace: w, command, pending } = useWorkspace()
const form = reactive({
    title: '',
    amount: '',
    category: 'Другое',
    accountId: '',
    frequency: 'monthly',
    interval: 1,
    startDate: localDate(),
    endDate: '',
    note: '',
  }),
  error = ref('')
watch(
  () => props.rule,
  (rule) => {
    Object.assign(
      form,
      rule
        ? {
            ...rule,
            amount: toMajor(rule.amount),
            accountId: rule.accountId || '',
            endDate: rule.endDate || '',
          }
        : {
            title: props.initial?.title || '',
            amount: props.initial?.amount || '',
            category: 'Другое',
            accountId: '',
            frequency: 'monthly',
            interval: 1,
            startDate: props.initial?.startDate || localDate(),
            endDate: '',
            note: '',
          },
    )
    error.value = ''
  },
  { immediate: true },
)
const options = computed(() => [
  ...new Set([
    ...categories.filter((c) => c !== 'Зарплата'),
    ...w.value.transactions.filter((t) => t.kind === 'expense').map((t) => t.category),
    ...w.value.recurringPayments.map((r) => r.category),
  ]),
])
async function save() {
  error.value = ''
  try {
    await command(
      {
        op: 'recurring.save',
        ...(props.rule ? { id: props.rule.id } : {}),
        data: {
          ...form,
          amount: toMinor(form.amount),
          accountId: form.accountId || null,
          endDate: form.endDate || null,
        },
      },
      'Расписание сохранено',
    )
    emit('saved')
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <form class="form-stack" @submit.prevent="save">
    <label
      >Название<input
        v-model="form.title"
        required
        maxlength="160"
        placeholder="Например, интернет или аренда"
    /></label>
    <div class="form-row">
      <label
        >Плановая сумма, ₽<input
          v-model="form.amount"
          inputmode="decimal"
          required
          placeholder="0,00" /></label
      ><label
        >Категория<input
          v-model="form.category"
          list="recurring-categories"
          required
          maxlength="160" /><datalist id="recurring-categories">
          <option v-for="category in options" :key="category" :value="category" /></datalist
      ></label>
    </div>
    <label
      >Счёт по умолчанию<select v-model="form.accountId">
        <option value="">Выбирать при оплате</option>
        <option
          v-for="account in w.accounts.filter((a) => !a.archived || a.id === rule?.accountId)"
          :key="account.id"
          :value="account.id"
        >
          {{ account.name }}{{ account.archived ? ' (архив)' : '' }}
        </option>
      </select></label
    >
    <div class="form-row">
      <label
        >Повтор<select v-model="form.frequency">
          <option value="monthly">По месяцам</option>
          <option value="weekly">По неделям</option>
          <option value="yearly">По годам</option>
        </select></label
      ><label
        >Каждые<input v-model.number="form.interval" type="number" min="1" max="12" required /><span
          class="form-hint"
          >{{
            form.frequency === 'monthly'
              ? 'месяцев'
              : form.frequency === 'weekly'
                ? 'недель'
                : 'лет'
          }}</span
        ></label
      >
    </div>
    <div class="form-row">
      <label>Первый платёж<input v-model="form.startDate" type="date" required /></label
      ><label
        >Последний день<input v-model="form.endDate" type="date" :min="form.startDate"
      /></label>
    </div>
    <label
      >Заметка<textarea
        v-model="form.note"
        rows="2"
        maxlength="1000"
        placeholder="Что стоит помнить при оплате"
      />
    </label>
    <p class="form-hint">
      День месяца берётся из первого платежа. Если такого дня нет, используется последний день
      месяца. Изменения действуют с сегодняшнего дня; прошлая история и подтверждённые оплаты
      сохраняются.
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <button class="button primary full" :disabled="pending">Сохранить расписание</button>
  </form>
</template>
