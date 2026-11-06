<script setup lang="ts">
import type { Obligation } from '../../shared/types'
import { localDate, toMinor, toMajor } from '../../shared/money'
import { obligationKinds } from '../../shared/obligations'
const props = defineProps<{ obligation?: Obligation | null }>()
const emit = defineEmits<{ saved: []; remove: [] }>()
const { workspace: w, command, pending } = useWorkspace()
const blank = () => ({
  title: '',
  kind: 'credit' as Obligation['kind'],
  openingBalance: '',
  startDate: localDate(),
  accountId: '',
  payment: '',
  dueDay: 10,
  rate: '0',
  interestMethod: 'monthly' as 'monthly' | 'actual365',
  bankText: '',
})
const form = reactive(blank()),
  error = ref('')
const hasHistory = computed(
  () =>
    !!props.obligation &&
    w.value.obligationEntries.some((e) => e.obligationId === props.obligation!.id),
)
watch(
  () => props.obligation,
  (o) => {
    Object.assign(
      form,
      o
        ? {
            ...o,
            openingBalance: toMajor(o.openingBalance),
            payment: toMajor(o.payment),
            accountId: o.accountId || '',
            bankText: (o.bankSchedule || [])
              .map(
                (r) =>
                  `${r.date}; ${toMajor(r.amount)}; ${r.interest === undefined ? '' : toMajor(r.interest)}`,
              )
              .join('\n'),
            interestMethod: o.interestMethod || 'monthly',
          }
        : blank(),
    )
    error.value = ''
  },
  { immediate: true },
)
const receivable = computed(() => form.kind === 'receivable')
async function save() {
  error.value = ''
  try {
    const data = {
      ...form,
      openingBalance: toMinor(form.openingBalance),
      payment: toMinor(form.payment || '0'),
      rate: form.rate.replace(',', '.'),
      accountId: form.accountId || null,
      bankSchedule: form.bankText.trim()
        ? form.bankText
            .trim()
            .split(/\r?\n/)
            .map((line) => {
              const [date = '', amount = '', interest = ''] = line.split(';').map((s) => s.trim())
              return {
                date,
                amount: toMinor(amount),
                ...(interest ? { interest: toMinor(interest) } : {}),
              }
            })
        : [],
    }
    await command(
      props.obligation
        ? { op: 'obligation.update', id: props.obligation.id, data }
        : { op: 'obligation.create', data },
      'Обязательство сохранено',
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
        placeholder="Например, ипотека на квартиру"
        required
        maxlength="160" /></label
    ><label
      >Тип<select v-model="form.kind">
        <option v-for="(name, key) in obligationKinds" :key="key" :value="key">{{ name }}</option>
      </select></label
    >
    <div class="form-row">
      <label
        >{{ receivable ? 'Сколько должны, ₽' : 'Остаток основного долга, ₽'
        }}<input v-model="form.openingBalance" inputmode="decimal" required placeholder="0,00"
      /></label>
      <label
        >На дату — начало учёта<input
          v-model="form.startDate"
          type="date"
          :max="localDate()"
          required
      /></label>
    </div>
    <p class="form-hint">
      Остаток на дату начала — точка отсчёта. Дальше он уменьшается по записанным платежам; сверка с
      банком поправит расхождение.
    </p>
    <div class="form-row">
      <label
        >{{ receivable ? 'Ожидаю в месяц, ₽' : 'Платёж в месяц, ₽'
        }}<input v-model="form.payment" inputmode="decimal" placeholder="0 — без графика" /></label
      ><label
        >День платежа<input v-model.number="form.dueDay" type="number" min="1" max="31" required
      /></label>
    </div>
    <div class="form-row">
      <label>Ставка, % годовых<input v-model="form.rate" inputmode="decimal" required /></label>
      <label
        >{{ receivable ? 'Счёт для возврата' : 'Счёт для платежей'
        }}<select v-model="form.accountId">
          <option value="">Выбирать при оплате</option>
          <option
            v-for="a in w.accounts.filter((a) => !a.archived || a.id === obligation?.accountId)"
            :key="a.id"
            :value="a.id"
          >
            {{ a.name }}
          </option>
        </select></label
      >
    </div>
    <p class="form-hint">
      Платёж в месяц появится в календаре и прогнозе до расчётной даты погашения.
      <template v-if="hasHistory"
        >Тип «Мне должны» нельзя поменять на долг и обратно: по обязательству уже есть
        погашения.</template
      >
    </p>
    <label
      >Расчёт процентов<select v-model="form.interestMethod">
        <option value="monthly">Оценка: ставка / 12</option>
        <option value="actual365">Фактические дни / 365</option>
      </select></label
    >
    <label
      >График банка<textarea
        v-model="form.bankText"
        rows="5"
        placeholder="2026-12-10; 15000; 2000"
      /><span class="form-hint"
        >Каждая строка: дата; платёж в рублях; проценты в рублях (необязательно). Введённые даты и
        суммы заменяют расчётный график; проценты из банка имеют приоритет.</span
      ></label
    >
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="dialog-actions">
      <button
        v-if="obligation"
        type="button"
        class="button ghost danger-text"
        @click="emit('remove')"
      >
        <AppIcon name="delete" :size="16" />Удалить</button
      ><button class="button primary" :disabled="pending">Сохранить</button>
    </div>
  </form>
</template>
