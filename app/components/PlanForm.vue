<script setup lang="ts">
import type { Plan, PlanDirection, PlanFrequency } from '../../shared/planning-types'
const { categoryNames: categories } = useCategories()
import { localDate, toMinor, toMajor } from '../../shared/money'
const props = defineProps<{
  plan?: Plan | null
  initial?: {
    title?: string
    amount?: string
    startDate?: string
    direction?: PlanDirection
    frequency?: PlanFrequency
  }
}>()
const emit = defineEmits<{ saved: [] }>()
const { workspace: w, command, pending } = useWorkspace()
const direction = ref<PlanDirection>('expense')
const form = reactive({
    title: '',
    amount: '',
    category: 'Другое',
    accountId: '',
    frequency: 'monthly' as PlanFrequency,
    interval: 1,
    startDate: localDate(),
    endDate: '',
    note: '',
    // "5, 20": several pay days a month; empty: the day of the first date.
    monthDays: '',
    workdays: false,
  }),
  error = ref('')
const once = computed(() => form.frequency === 'once')
watch(
  [() => props.plan, () => props.initial],
  ([plan, initial]) => {
    direction.value = plan?.direction || initial?.direction || 'expense'
    Object.assign(
      form,
      plan
        ? {
            ...plan,
            amount: toMajor(plan.amount),
            accountId: plan.accountId || '',
            endDate: plan.endDate || '',
            monthDays: plan.monthDays.join(', '),
            workdays: plan.holidayShift === 'before',
          }
        : {
            title: initial?.title || '',
            amount: initial?.amount || '',
            category: direction.value === 'income' ? 'Зарплата' : 'Другое',
            accountId: '',
            frequency: initial?.frequency || 'monthly',
            interval: 1,
            startDate: initial?.startDate || localDate(),
            endDate: '',
            note: '',
            monthDays: '',
            workdays: false,
          },
    )
    error.value = ''
  },
  { immediate: true },
)
function chooseDirection(value: PlanDirection) {
  if (props.plan) return
  direction.value = value
  if (['Зарплата', 'Другое'].includes(form.category))
    form.category = value === 'income' ? 'Зарплата' : 'Другое'
}
const options = computed(() => {
  const kind = direction.value
  return [
    ...new Set([
      ...(kind === 'income'
        ? ['Зарплата', 'Другое']
        : categories.value.filter((c) => c !== 'Зарплата')),
      ...w.value.transactions.filter((t) => t.kind === kind).map((t) => t.category),
      ...w.value.plans.filter((p) => p.direction === kind).map((p) => p.category),
    ]),
  ]
})
// Switching between one-off and recurring would rewrite history, so an existing plan keeps its type.
const frequencies = computed(() =>
  [
    { value: 'once', label: 'Один раз' },
    { value: 'monthly', label: 'По месяцам' },
    { value: 'weekly', label: 'По неделям' },
    { value: 'yearly', label: 'По годам' },
  ].filter((f) => !props.plan || (props.plan.frequency === 'once') === (f.value === 'once')),
)
const monthly = computed(() => form.frequency === 'monthly')
const parsedDays = computed(() => [...new Set((form.monthDays.match(/\d+/g) || []).map(Number))])
async function save() {
  error.value = ''
  try {
    if (monthly.value && parsedDays.value.some((d) => d < 1 || d > 31))
      throw new Error('Дни месяца — числа от 1 до 31')
    const { monthDays: _days, workdays, ...fields } = form
    await command(
      {
        op: 'plan.save',
        ...(props.plan ? { id: props.plan.id } : {}),
        direction: direction.value,
        data: {
          ...fields,
          monthDays: monthly.value && parsedDays.value.length ? parsedDays.value : [],
          holidayShift: !once.value && direction.value === 'income' && workdays ? 'before' : 'none',
          amount: toMinor(form.amount),
          accountId: form.accountId || null,
          interval: once.value ? 1 : form.interval,
          endDate: once.value ? null : form.endDate || null,
        },
      },
      'План сохранён',
    )
    emit('saved')
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <form class="form-stack" @submit.prevent="save">
    <div class="segmented">
      <button
        type="button"
        :class="{ selected: direction === 'expense' }"
        :disabled="!!plan && direction !== 'expense'"
        @click="chooseDirection('expense')"
      >
        Платёж</button
      ><button
        type="button"
        :class="{ selected: direction === 'income' }"
        :disabled="!!plan && direction !== 'income'"
        @click="chooseDirection('income')"
      >
        Поступление
      </button>
    </div>
    <label
      >Название<input
        v-model="form.title"
        required
        maxlength="160"
        :placeholder="direction === 'income' ? 'Например, зарплата или аванс' : 'Например, аренда'"
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
          list="plan-categories"
          required
          maxlength="160" /><datalist id="plan-categories">
          <option v-for="category in options" :key="category" :value="category" /></datalist
      ></label>
    </div>
    <label
      >{{ direction === 'income' ? 'Счёт зачисления' : 'Счёт по умолчанию'
      }}<select v-model="form.accountId">
        <option value="">Выбирать при подтверждении</option>
        <option
          v-for="account in w.accounts.filter((a) => !a.archived || a.id === plan?.accountId)"
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
          <option v-for="f in frequencies" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select></label
      ><label v-if="!once"
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
      <label
        >{{ once ? 'Дата' : 'Первая дата'
        }}<input v-model="form.startDate" type="date" required /></label
      ><label v-if="!once"
        >Последний день<input v-model="form.endDate" type="date" :min="form.startDate"
      /></label>
    </div>
    <label v-if="monthly"
      >Дни выплаты в месяце<input
        v-model="form.monthDays"
        inputmode="numeric"
        maxlength="20"
        placeholder="Например, 5, 20 — или пусто: день первой даты"
      /><span class="form-hint"
        >Укажите до четырёх дней через запятую, если деньги приходят несколько раз в месяц: аванс и
        зарплата.</span
      ></label
    >
    <label v-if="!once && direction === 'income'" class="checkbox-row"
      ><input v-model="form.workdays" type="checkbox" /><span
        >Работаю по графику 5/2<small
          >Если день выплаты выпадает на выходной или праздник, зарплата приходит накануне — в
          предыдущий рабочий день (ТК РФ, ст. 136). При сменном графике оставьте выключенным.</small
        ></span
      ></label
    >
    <label
      >Заметка<textarea
        v-model="form.note"
        rows="2"
        maxlength="1000"
        placeholder="Что стоит помнить при подтверждении"
      />
    </label>
    <p class="form-hint">
      {{
        once
          ? 'Разовый план появится в календаре и прогнозе на выбранную дату. Операция записывается только после подтверждения.'
          : 'Если дни выплаты не указаны, день месяца берётся из первой даты; если такого дня нет, используется последний день месяца. Изменения действуют с сегодняшнего дня: прошлые даты и подтверждения сохраняются, а перенос и изменение суммы будущих дат сбрасываются.'
      }}
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <button class="button primary full" :disabled="pending">Сохранить план</button>
  </form>
</template>
