<script setup lang="ts">
import { money, toMinor, localDate, sumAmounts } from '../../shared/money'
import { addDays, monthRange, projectPayments } from '../../shared/planning'
import type { CalendarEvent } from '../../shared/types'
import type { ProjectedPayment } from '../../shared/planning-types'
import { z } from 'zod'
const { workspace: w, command, pending } = useWorkspace()
const now = new Date(),
  month = ref(new Date(now.getFullYear(), now.getMonth(), 1)),
  selected = ref(localDate()),
  open = ref(false),
  error = ref(''),
  deleting = ref<string | null>(null)
const form = reactive({ title: '', date: localDate(), kind: 'task', amount: '', note: '' })
const route = useRoute()
const paying = ref<ProjectedPayment | null>(null)
type CalendarEntry = CalendarEvent & { payment?: ProjectedPayment }
const calendarRange = computed(() => {
  const first = new Date(month.value)
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7))
  const from = localDate(first)
  return { from, to: addDays(from, 41) }
})
const calendarEvents = computed<CalendarEntry[]>(() => [
  ...w.value.events,
  ...projectPayments(w.value, calendarRange.value.from, calendarRange.value.to).map((p) => ({
    id: p.id,
    title: p.title,
    date: p.dueDate,
    kind: 'payment',
    amount: p.amount,
    done: ['paid', 'skipped'].includes(p.status),
    note: p.note,
    payment: p,
  })),
])
const monthlyPayments = computed(() => {
  const range = monthRange(localDate(month.value).slice(0, 7))
  return projectPayments(w.value, range.from, range.to)
})
const toPay = computed(() =>
  monthlyPayments.value.filter((p) => ['pending', 'deleted'].includes(p.status)),
)
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
  Object.assign(form, { title: '', date: selected.value, kind: 'task', amount: '', note: '' })
  error.value = ''
  open.value = true
}
async function save() {
  error.value = ''
  try {
    await command(
      {
        op: 'event.create',
        data: { ...form, amount: form.kind === 'payment' ? toMinor(form.amount) : null },
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
      <p>Дела, заметки и важные платежи в одном календаре.</p>
    </div>
    <div class="heading-actions">
      <NuxtLink to="/recurring" class="button secondary"
        ><AppIcon name="repeat" :size="17" />Расписания</NuxtLink
      ><button class="button primary" @click="create">
        <AppIcon name="plus" :size="18" />Новая запись
      </button>
    </div>
  </div>
  <div v-if="monthlyPayments.length" class="summary-strip calendar-payment-summary">
    <div>
      <span>Повторы: ещё к оплате</span
      ><strong>{{ money(sumAmounts(toPay.map((p) => p.amount))) }}</strong>
    </div>
    <div>
      <span>Оплачено дат месяца</span
      ><strong>{{ monthlyPayments.filter((p) => p.status === 'paid').length }}</strong>
    </div>
    <div>
      <span>Срок прошёл</span
      ><strong :class="{ 'budget-danger': toPay.some((p) => p.dueDate < localDate()) }">{{
        toPay.filter((p) => p.dueDate < localDate()).length
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
        <button class="button secondary small-button" @click="today">Сегодня</button>
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
            v-for="event in day.events.slice(0, 2)"
            :key="event.id"
            class="calendar-event"
            :class="[event.kind, event.payment?.status, { done: event.done }]"
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
        </div>
      </div>
      <template v-for="event in selectedEvents" :key="event.id"
        ><PaymentItem v-if="event.payment" :payment="event.payment" @pay="paying = $event" />
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
            <span class="event-type">{{
              event.kind === 'payment' ? 'Платёж' : event.kind === 'note' ? 'Заметка' : 'Дело'
            }}</span
            ><strong>{{ event.title }}</strong
            ><span v-if="event.amount" class="day-event-amount">{{ money(event.amount) }}</span>
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
      Оплата повторяющегося платежа связывает расход с календарём. Для обычных дел и заметок
      доступна простая отметка выполнения. Все даты повторов рассчитываются из расписания, включая
      короткие месяцы.
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
            <option value="note">Заметка</option>
          </select></label
        ><label>Дата<input v-model="form.date" type="date" required /></label>
      </div>
      <label v-if="form.kind === 'payment'"
        >Плановая сумма, ₽<input
          v-model="form.amount"
          inputmode="decimal"
          placeholder="0,00"
          required /></label
      ><label
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
  <PaymentDialog v-model="paying" />
</template>
