<script setup lang="ts">
import { money, toMinor, localDate, sumAmounts } from '../../shared/money'
import { addDays, monthRange, projectPlans, isOpen } from '../../shared/planning'
import type { CalendarEvent } from '../../shared/types'
import type { ProjectedOccurrence } from '../../shared/planning-types'
import { balanceAt, forecast } from '../../shared/forecast'
import { z } from 'zod'
const { workspace: w, command, pending } = useWorkspace()
const now = new Date(),
  month = ref(new Date(now.getFullYear(), now.getMonth(), 1)),
  selected = ref(localDate()),
  open = ref(false),
  error = ref(''),
  deleting = ref<string | null>(null)
const form = reactive({
  title: '',
  date: localDate(),
  kind: 'task',
  amount: '',
  category: '',
  note: '',
})
const isPlan = computed(() => form.kind === 'payment' || form.kind === 'income')
const route = useRoute()
const confirming = ref<ProjectedOccurrence | null>(null)
type CalendarEntry = Omit<CalendarEvent, 'amount'> & {
  amount: string | null
  plan?: ProjectedOccurrence
}
const calendarRange = computed(() => {
  const first = new Date(month.value)
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7))
  const from = localDate(first)
  return { from, to: addDays(from, 41) }
})
const calendarEvents = computed<CalendarEntry[]>(() => [
  ...w.value.events,
  ...projectPlans(w.value, calendarRange.value.from, calendarRange.value.to).map((p) => ({
    id: p.id,
    title: p.title,
    date: p.date,
    kind: p.direction === 'income' ? 'income' : 'payment',
    amount: p.amount,
    done: !isOpen(p),
    note: p.note,
    plan: p,
  })),
])
const monthlyPlans = computed(() => {
  const range = monthRange(localDate(month.value).slice(0, 7))
  return projectPlans(w.value, range.from, range.to)
})
const openPlans = computed(() => monthlyPlans.value.filter(isOpen))
const openSum = (direction: 'income' | 'expense') =>
  sumAmounts(openPlans.value.filter((p) => p.direction === direction).map((p) => p.amount))
onMounted(() => {
  if (typeof route.query.date === 'string' && z.iso.date().safeParse(route.query.date).success) {
    selected.value = route.query.date
    month.value = new Date(selected.value.slice(0, 7) + '-01T12:00:00')
  }
  if (typeof route.query.title !== 'string') return
  const dueDay = Math.max(1, Math.min(31, Number(route.query.day) || now.getDate()))
  let date = new Date(
    now.getFullYear(),
    now.getMonth(),
    Math.min(dueDay, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()),
  )
  if (localDate(date) < localDate())
    date = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      Math.min(dueDay, new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate()),
    )
  selected.value = localDate(date)
  month.value = new Date(date.getFullYear(), date.getMonth(), 1)
  Object.assign(form, {
    title: route.query.title,
    date: selected.value,
    kind: 'payment',
    amount: typeof route.query.amount === 'string' ? route.query.amount : '',
    category: 'Другое',
  })
  open.value = true
})
const monthLabel = computed(() =>
  new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
    .format(month.value)
    .replace(' г.', ''),
)
const days = computed(() => {
  const first = new Date(month.value),
    offset = (first.getDay() + 6) % 7
  first.setDate(first.getDate() - offset)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(first)
    d.setDate(d.getDate() + i)
    const date = localDate(d)
    return {
      date,
      day: d.getDate(),
      muted: d.getMonth() !== month.value.getMonth(),
      today: date === localDate(),
      events: calendarEvents.value.filter((e) => e.date === date),
    }
  })
})
// Financial view: recorded balance for past days, expected balance from today on.
const moneyView = ref(false)
const forecastLimit = 400
const dayBalances = computed(() => {
  const result = new Map<string, { value: string; expected: boolean }>()
  if (!moneyView.value) return result
  const today = localDate(),
    { from, to } = calendarRange.value
  for (let date = from; date <= to && date < today; date = addDays(date, 1))
    result.set(date, { value: balanceAt(w.value, date), expected: false })
  if (to >= today) {
    const span = Math.round((Date.parse(to) - Date.parse(today)) / 86400000)
    if (span <= forecastLimit)
      for (const day of forecast(w.value, today, span).days)
        if (day.date >= from) result.set(day.date, { value: day.total, expected: true })
  }
  return result
})
const selectedEvents = computed(() => calendarEvents.value.filter((e) => e.date === selected.value))
const selectedTitle = computed(() =>
  new Date(selected.value + 'T12:00:00').toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }),
)
function changeMonth(delta: number) {
  month.value = new Date(month.value.getFullYear(), month.value.getMonth() + delta, 1)
}
function today() {
  month.value = new Date(now.getFullYear(), now.getMonth(), 1)
  selected.value = localDate()
}
function create() {
  Object.assign(form, {
    title: '',
    date: selected.value,
    kind: 'task',
    amount: '',
    category: '',
    note: '',
  })
  error.value = ''
  open.value = true
}
watch(
  () => form.kind,
  (kind) => {
    if (!form.category || ['Другое', 'Зарплата'].includes(form.category))
      form.category = kind === 'income' ? 'Зарплата' : 'Другое'
  },
)
async function save() {
  error.value = ''
  try {
    // Payments and incomes become one-off plans so they reach the budget and can be confirmed.
    await command(
      isPlan.value
        ? {
            op: 'plan.save',
            direction: form.kind === 'income' ? 'income' : 'expense',
            data: {
              title: form.title,
              category: form.category || 'Другое',
              amount: toMinor(form.amount),
              accountId: null,
              frequency: 'once',
              interval: 1,
              startDate: form.date,
              endDate: null,
              note: form.note,
            },
          }
        : {
            op: 'event.create',
            data: { title: form.title, date: form.date, kind: form.kind, note: form.note },
          },
      'Запись добавлена в календарь',
    )
    open.value = false
    selected.value = form.date
    month.value = new Date(form.date.slice(0, 7) + '-01T12:00:00')
  } catch (e: any) {
    error.value = e.message
  }
}
async function toggle(id: string, done: boolean) {
  try {
    await command({ op: 'event.toggle', id, done })
  } catch {}
}
async function remove() {
  try {
    await command({ op: 'event.delete', id: deleting.value }, 'Запись удалена')
    deleting.value = null
  } catch {}
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">У ВСЕГО ЕСТЬ СВОЁ ВРЕМЯ</div>
      <h1>Планы без суеты<span class="title-dot">.</span></h1>
      <p>Дела, заметки, поступления и платежи в одном календаре.</p>
    </div>
    <div class="heading-actions">
      <NuxtLink to="/plans" class="button secondary"
        ><AppIcon name="repeat" :size="17" />Планы</NuxtLink
      ><button class="button primary" @click="create">
        <AppIcon name="plus" :size="18" />Новая запись
      </button>
    </div>
  </div>
  <div v-if="monthlyPlans.length" class="summary-strip calendar-payment-summary">
    <div>
      <span>Ожидается поступлений</span
      ><strong class="text-green">+{{ money(openSum('income')) }}</strong>
    </div>
    <div>
      <span>Ещё к оплате</span><strong>{{ money(openSum('expense')) }}</strong>
    </div>
    <div>
      <span>Срок прошёл</span
      ><strong :class="{ 'budget-danger': openPlans.some((p) => p.date < localDate()) }">{{
        openPlans.filter((p) => p.date < localDate()).length
      }}</strong>
    </div>
  </div>
  <div class="calendar-layout">
    <section class="panel calendar-panel">
      <div class="calendar-toolbar">
        <div class="period-control">
          <button class="icon-button" aria-label="Предыдущий месяц" @click="changeMonth(-1)">
            <AppIcon name="left" :size="17" />
          </button>
          <h2>{{ monthLabel }}</h2>
          <button class="icon-button" aria-label="Следующий месяц" @click="changeMonth(1)">
            <AppIcon name="right" :size="17" />
          </button>
        </div>
        <div class="calendar-toolbar-actions">
          <button
            class="button secondary small-button"
            :class="{ active: moneyView }"
            :aria-pressed="moneyView"
            @click="moneyView = !moneyView"
          >
            <AppIcon name="forecast" :size="15" />Остатки
          </button>
          <button class="button secondary small-button" @click="today">Сегодня</button>
        </div>
      </div>
      <div class="calendar-weekdays">
        <span v-for="d in ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']" :key="d">{{ d }}</span>
      </div>
      <div class="calendar-grid">
        <button
          v-for="day in days"
          :key="day.date"
          class="calendar-day"
          :class="{ 'muted-day': day.muted, today: day.today, selected: day.date === selected }"
          :aria-label="`${day.date}, записей: ${day.events.length}`"
          :aria-pressed="day.date === selected"
          @click="selected = day.date"
        >
          <span class="day-number">{{ day.day }}</span
          ><span
            v-if="dayBalances.get(day.date)"
            class="calendar-balance"
            :class="{
              expected: dayBalances.get(day.date)!.expected,
              negative: BigInt(dayBalances.get(day.date)!.value) < 0n,
            }"
            >{{ money(dayBalances.get(day.date)!.value, true) }}</span
          ><span
            v-for="event in day.events.slice(0, 2)"
            :key="event.id"
            class="calendar-event"
            :class="[event.kind, event.plan?.status, { done: event.done }]"
            ><i />{{ event.title }}</span
          ><span v-if="day.events.length > 2" class="calendar-more"
            >+{{ day.events.length - 2 }}</span
          ><span class="mobile-event-dots"
            ><i v-for="event in day.events.slice(0, 3)" :key="event.id" :class="event.kind"
          /></span>
        </button>
      </div>
    </section>
    <aside class="panel day-panel">
      <div class="panel-heading">
        <div>
          <span class="eyebrow">ПЛАН НА ДЕНЬ</span>
          <h2>{{ selectedTitle }}</h2>
          <p v-if="dayBalances.get(selected)" class="calendar-day-balance">
            {{ dayBalances.get(selected)!.expected ? 'Ожидаемый остаток' : 'Остаток' }}
            на конец дня:
            <strong :class="{ 'danger-text': BigInt(dayBalances.get(selected)!.value) < 0n }">{{
              money(dayBalances.get(selected)!.value)
            }}</strong>
          </p>
        </div>
      </div>
      <template v-for="event in selectedEvents" :key="event.id"
        ><PlanItem v-if="event.plan" :item="event.plan" @confirm="confirming = $event" />
        <div v-else class="day-event">
          <button
            class="check-box"
            :class="{ checked: event.done }"
            :aria-label="event.done ? 'Отметить невыполненным' : 'Отметить выполненным'"
            :disabled="pending"
            @click="toggle(event.id, !event.done)"
          >
            <AppIcon v-if="event.done" name="check" :size="13" />
          </button>
          <div :class="{ 'is-done': event.done }">
            <span class="event-type">{{ event.kind === 'note' ? 'Заметка' : 'Дело' }}</span
            ><strong>{{ event.title }}</strong>
            <p v-if="event.note">{{ event.note }}</p>
          </div>
          <button class="icon-button" aria-label="Удалить запись" @click="deleting = event.id">
            <AppIcon name="delete" :size="15" />
          </button></div
      ></template>
      <div v-if="!selectedEvents.length" class="empty-state">
        <AppIcon name="calendar" :size="32" /><strong>Свободный день</strong>
        <p>Оставьте место для важного.</p>
      </div>
      <button class="panel-bottom-link" @click="create">
        <AppIcon name="plus" :size="16" />Добавить запись
      </button>
    </aside>
  </div>
  <div class="note-card">
    <AppIcon name="bell" :size="21" />
    <p>
      Подтверждение поступления или платежа связывает с календарём доход или расход. Отдельную дату
      можно перенести, изменить её сумму или отменить — остальное расписание не меняется. Для дел и
      заметок доступна простая отметка выполнения.
    </p>
  </div>
  <AppDialog v-model="open" title="Новая запись" description="Освободите голову — запишите здесь."
    ><form class="form-stack" @submit.prevent="save">
      <label
        >Что запланировано<input
          v-model="form.title"
          placeholder="Например, оплатить интернет"
          required
          maxlength="160"
      /></label>
      <div class="form-row">
        <label
          >Тип<select v-model="form.kind">
            <option value="task">Дело</option>
            <option value="payment">Платёж</option>
            <option value="income">Поступление</option>
            <option value="note">Заметка</option>
          </select></label
        ><label>Дата<input v-model="form.date" type="date" required /></label>
      </div>
      <div v-if="isPlan" class="form-row">
        <label
          >Плановая сумма, ₽<input
            v-model="form.amount"
            inputmode="decimal"
            placeholder="0,00"
            required /></label
        ><label>Категория<input v-model="form.category" required maxlength="160" /></label>
      </div>
      <p v-if="isPlan" class="form-hint">
        {{ form.kind === 'income' ? 'Поступление' : 'Платёж' }} станет разовым планом: его можно
        подтвердить операцией, перенести или отменить.
      </p>
      <label
        >Заметка<textarea
          v-model="form.note"
          placeholder="Детали, о которых стоит помнить"
          maxlength="1000"
          rows="3"
        />
      </label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="button primary full" :disabled="pending">Добавить в календарь</button>
    </form></AppDialog
  >
  <AppDialog
    :model-value="!!deleting"
    title="Удалить запись?"
    description="Запись исчезнет из календаря."
    @update:model-value="deleting = null"
    ><div class="dialog-actions">
      <button class="button secondary" @click="deleting = null">Отмена</button
      ><button class="button danger" :disabled="pending" @click="remove">Удалить</button>
    </div></AppDialog
  >
  <PlanConfirmDialog v-model="confirming" />
</template>
