<script setup lang="ts">
import type { ProjectedOccurrence } from '../../shared/planning-types'
import { money, localDate, toMinor, toMajor } from '../../shared/money'
const props = defineProps<{ item: ProjectedOccurrence }>()
const emit = defineEmits<{ confirm: [item: ProjectedOccurrence] }>()
const { workspace: w, command, pending } = useWorkspace()
const skipOpen = ref(false),
  adjustOpen = ref(false),
  adjustDate = ref(''),
  adjustAmount = ref(''),
  adjustError = ref('')
const income = computed(() => props.item.direction === 'income')
const overdue = computed(() => props.item.status === 'pending' && props.item.date < localDate())
const day = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
const label = computed(() => {
  const item = props.item
  if (item.status === 'paid') return income.value ? 'Получено' : 'Оплачен'
  if (item.status === 'skipped') return 'Отменено'
  if (item.status === 'closed') return 'Отмечено без операции'
  if (item.status === 'deleted')
    return income.value ? 'Связанный доход удалён' : 'Связанный расход удалён'
  if (overdue.value) return 'Срок прошёл'
  if (item.movedTo) return `Перенесено с ${day(item.dueDate)}`
  if (income.value) return 'Ожидаемое поступление'
  return item.frequency === 'once' ? 'Разовый платёж' : 'Регулярный платёж'
})
const icon = computed(() =>
  props.item.status === 'paid'
    ? 'done'
    : props.item.status === 'skipped' || props.item.status === 'closed'
      ? 'close'
      : props.item.status === 'deleted'
        ? 'restore'
        : income.value
          ? 'income'
          : props.item.frequency === 'once'
            ? 'calendar'
            : 'repeat',
)
const key = () => ({
  planId: props.item.planId,
  dueDate: props.item.dueDate,
  expectedRevision: w.value.revision,
})
async function skip() {
  try {
    await command({ op: 'occurrence.skip', ...key() }, 'Дата отменена')
    skipOpen.value = false
  } catch {}
}
async function unskip() {
  try {
    await command({ op: 'occurrence.unskip', ...key() }, 'Дата возвращена в план')
  } catch {}
}
function openAdjust() {
  adjustDate.value = props.item.date
  adjustAmount.value = toMajor(props.item.amount)
  adjustError.value = ''
  adjustOpen.value = true
}
async function adjust() {
  adjustError.value = ''
  try {
    await command(
      {
        op: 'occurrence.adjust',
        ...key(),
        date: adjustDate.value,
        amount: toMinor(adjustAmount.value),
      },
      'Дата плана изменена',
    )
    adjustOpen.value = false
  } catch (e: any) {
    adjustError.value = e.message
  }
}
async function restore() {
  try {
    await command(
      { op: 'transaction.restore', id: props.item.transactionId },
      income.value ? 'Связанный доход восстановлен' : 'Связанный расход восстановлен',
    )
  } catch {}
}
</script>
<template>
  <article class="payment-item" :class="[item.status, item.direction, { overdue }]">
    <div class="payment-item-top">
      <span class="payment-status-icon"><AppIcon :name="icon" :size="19" /></span>
      <div>
        <span class="event-type">{{ label }}</span
        ><strong>{{ item.title }}</strong
        ><span class="payment-category"
          >{{ item.category }} ·
          {{ new Date(item.date + 'T12:00:00').toLocaleDateString('ru-RU') }}</span
        >
      </div>
      <strong class="payment-item-amount" :class="{ 'text-green': income }"
        >{{ income ? '+' : ''
        }}{{
          money(item.status === 'paid' ? item.actualAmount || item.amount : item.amount)
        }}</strong
      >
    </div>
    <p v-if="item.note" class="payment-note">{{ item.note }}</p>
    <div class="payment-item-actions">
      <template v-if="item.status === 'pending'"
        ><button
          class="button primary small-button"
          :disabled="pending"
          :aria-label="`${income ? 'Получил' : 'Оплатил'}: ${item.title}`"
          @click="emit('confirm', item)"
        >
          {{ income ? 'Получил' : 'Оплатил' }}</button
        ><button
          class="text-button"
          :disabled="pending"
          :aria-label="`Перенести или изменить сумму: ${item.title}`"
          @click="openAdjust"
        >
          Изменить</button
        ><button
          class="text-button"
          :disabled="pending"
          :aria-label="`Отменить дату: ${item.title}`"
          @click="skipOpen = true"
        >
          Отменить
        </button></template
      ><button
        v-else-if="item.status === 'skipped' || item.status === 'closed'"
        class="text-button"
        :disabled="pending"
        @click="unskip"
      >
        Вернуть в план</button
      ><button
        v-else-if="item.status === 'deleted'"
        class="button secondary small-button"
        :disabled="pending"
        @click="restore"
      >
        <AppIcon name="restore" :size="14" />{{
          income ? 'Восстановить доход' : 'Восстановить расход'
        }}</button
      ><NuxtLink
        v-if="item.status === 'paid'"
        :to="{ path: '/transactions', query: { transaction: item.transactionId } }"
        class="text-button"
        >{{ income ? 'Доход' : 'Расход' }} от
        {{ new Date((item.actualDate || item.date) + 'T12:00:00').toLocaleDateString('ru-RU') }}
        <AppIcon name="arrow" :size="14"
      /></NuxtLink>
    </div>
  </article>
  <AppDialog v-model="skipOpen" title="Отменить эту дату?" :description="item.title"
    ><p class="form-hint">
      Отмена относится только к этой дате: план продолжит действовать, операция не создаётся. Дату
      можно вернуть в план.
    </p>
    <div class="dialog-actions">
      <button class="button secondary" @click="skipOpen = false">Не отменять</button
      ><button class="button primary" :disabled="pending" @click="skip">Отменить дату</button>
    </div></AppDialog
  >
  <AppDialog
    v-model="adjustOpen"
    title="Изменить дату плана"
    :description="`${item.title} · по расписанию ${day(item.dueDate)}`"
    ><form class="form-stack" @submit.prevent="adjust">
      <div class="form-row">
        <label>Новая дата<input v-model="adjustDate" type="date" required /></label
        ><label
          >Сумма, ₽<input v-model="adjustAmount" class="amount-input" inputmode="decimal" required
        /></label>
      </div>
      <p class="form-hint">
        Перенос и новая сумма относятся только к этой дате. Остальные даты и настройки плана не
        меняются.
      </p>
      <p v-if="adjustError" class="form-error" role="alert">{{ adjustError }}</p>
      <button class="button primary full" :disabled="pending">Сохранить дату</button>
    </form></AppDialog
  >
</template>
