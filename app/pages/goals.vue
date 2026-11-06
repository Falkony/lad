<script setup lang="ts">
import type { Goal } from '../../shared/types'
import { money, toMinor, toMajor } from '../../shared/money'
const { workspace: w, command, pending } = useWorkspace()
const open = ref(false),
  editing = ref<Goal | null>(null),
  deleting = ref<Goal | null>(null),
  error = ref(''),
  dragging = ref<string | null>(null)
const form = reactive({
  title: '',
  target: '',
  saved: '',
  status: 'wish',
  priority: 'normal',
  deadline: '',
})
const columns = [
  { id: 'wish', label: 'Хочу', hint: 'Идеи для лучшей жизни', icon: 'sparkles' },
  { id: 'saving', label: 'Коплю', hint: 'Маленькими шагами к цели', icon: 'savings' },
  { id: 'planned', label: 'Запланировано', hint: 'Осталось сделать шаг', icon: 'calendar' },
  { id: 'done', label: 'Исполнено', hint: 'Повод порадоваться', icon: 'done' },
]
function requestDelete() {
  deleting.value = editing.value
  open.value = false
}
function edit(goal?: Goal, status = 'wish') {
  editing.value = goal || null
  Object.assign(
    form,
    goal
      ? {
          ...goal,
          target: toMajor(goal.target),
          saved: toMajor(goal.saved),
          deadline: goal.deadline || '',
        }
      : { title: '', target: '', saved: '', status, priority: 'normal', deadline: '' },
  )
  error.value = ''
  open.value = true
}
async function save() {
  error.value = ''
  try {
    const data = {
      ...form,
      target: toMinor(form.target),
      saved: toMinor(form.saved || '0'),
      deadline: form.deadline || null,
    }
    await command(
      editing.value
        ? { op: 'goal.update', id: editing.value.id, data }
        : { op: 'goal.create', data },
      editing.value ? 'Цель обновлена' : 'Новая цель добавлена',
    )
    open.value = false
  } catch (e: any) {
    error.value = e.message
  }
}
async function move(goal: Goal, status: string) {
  try {
    await command(
      { op: 'goal.update', id: goal.id, data: { ...goal, status } },
      'Статус цели изменён',
    )
  } catch {}
}
async function drop(status: string) {
  const goal = w.value.goals.find((g) => g.id === dragging.value)
  dragging.value = null
  if (goal && goal.status !== status) await move(goal, status)
}
async function remove() {
  if (!deleting.value) return
  try {
    await command({ op: 'goal.delete', id: deleting.value.id }, 'Цель удалена')
    deleting.value = null
  } catch {}
}
const progress = (g: Goal) => Math.min(100, Math.round((Number(g.saved) / Number(g.target)) * 100))
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">МЕСТО ДЛЯ БОЛЬШИХ И МАЛЕНЬКИХ ЖЕЛАНИЙ</div>
      <h1>Ближе к желаемому<span class="title-dot">.</span></h1>
      <p>Превратите «когда-нибудь» в понятный следующий шаг.</p>
    </div>
    <button class="button primary" @click="edit()">
      <AppIcon name="plus" :size="18" />Добавить цель
    </button>
  </div>
  <div class="note-card goal-note">
    <AppIcon name="sprout" :size="24" />
    <p>
      Накопления в карточках — ваш план распределения денег. Изменение суммы цели не создаёт
      операцию и не меняет баланс счетов.
    </p>
  </div>
  <div class="kanban">
    <section
      v-for="column in columns"
      :key="column.id"
      class="kanban-column"
      :class="column.id"
      @dragover.prevent
      @drop.prevent="drop(column.id)"
    >
      <div class="kanban-heading">
        <span class="column-dot" />
        <h2>{{ column.label }}</h2>
        <span class="count-label">{{ w.goals.filter((g) => g.status === column.id).length }}</span
        ><button
          class="icon-button"
          :aria-label="`Добавить цель в ${column.label}`"
          @click="edit(undefined, column.id)"
        >
          <AppIcon name="plus" :size="17" />
        </button>
      </div>
      <p class="kanban-hint">{{ column.hint }}</p>
      <article
        v-for="goal in w.goals.filter((g) => g.status === column.id)"
        :key="goal.id"
        class="goal-card"
        draggable="true"
        @dragstart="dragging = goal.id"
        @dragend="dragging = null"
      >
        <div class="goal-card-top">
          <span class="goal-card-icon"><AppIcon :name="column.icon" :size="22" /></span
          ><button
            class="icon-button"
            :aria-label="`Редактировать ${goal.title}`"
            @click="edit(goal)"
          >
            <AppIcon name="more" :size="18" />
          </button>
        </div>
        <button class="goal-card-title" @click="edit(goal)">{{ goal.title }}</button
        ><span v-if="goal.priority === 'high'" class="priority-badge">В приоритете</span>
        <div class="goal-card-values">
          <strong>{{ money(goal.saved, true) }}</strong
          ><span>из {{ money(goal.target, true) }}</span>
        </div>
        <div class="progress-bar"><span :style="{ width: `${progress(goal)}%` }" /></div>
        <div class="goal-card-footer">
          <span>{{ progress(goal) }}%</span
          ><span v-if="goal.deadline"
            ><AppIcon name="calendar" :size="12" />{{
              new Date(goal.deadline + 'T12:00:00').toLocaleDateString('ru-RU', {
                day: 'numeric',
                month: 'short',
              })
            }}</span
          >
        </div>
        <label class="status-select"
          ><span class="sr-only">Статус {{ goal.title }}</span
          ><select
            :value="goal.status"
            :disabled="pending"
            @change="move(goal, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="c in columns" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select></label
        >
      </article>
      <button class="kanban-add" @click="edit(undefined, column.id)">
        <AppIcon name="plus" :size="15" />Добавить цель
      </button>
    </section>
  </div>
  <AppDialog
    v-model="open"
    :title="editing ? 'Редактировать цель' : 'Новая цель'"
    description="На что хочется направить свои деньги?"
    ><form class="form-stack" @submit.prevent="save">
      <label
        >Название<input
          v-model="form.title"
          placeholder="Например, отпуск у моря"
          required
          maxlength="160"
      /></label>
      <div class="form-row">
        <label
          >Нужно накопить, ₽<input
            v-model="form.target"
            inputmode="decimal"
            placeholder="0,00"
            required /></label
        ><label
          >Уже отложено, ₽<input v-model="form.saved" inputmode="decimal" placeholder="0,00"
        /></label>
      </div>
      <div class="form-row">
        <label
          >Статус<select v-model="form.status">
            <option v-for="c in columns" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select></label
        ><label
          >Приоритет<select v-model="form.priority">
            <option value="normal">Обычный</option>
            <option value="high">Высокий</option>
          </select></label
        >
      </div>
      <label>Желаемая дата<input v-model="form.deadline" type="date" /></label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button
          v-if="editing"
          class="button ghost danger-text"
          type="button"
          @click="requestDelete"
        >
          <AppIcon name="delete" :size="16" />Удалить</button
        ><button class="button primary" :disabled="pending">Сохранить цель</button>
      </div>
    </form></AppDialog
  >
  <AppDialog
    :model-value="!!deleting"
    title="Удалить цель?"
    :description="deleting?.title"
    @update:model-value="deleting = null"
    ><div class="dialog-actions">
      <button class="button secondary" @click="deleting = null">Отмена</button
      ><button class="button danger" :disabled="pending" @click="remove">Удалить</button>
    </div></AppDialog
  >
</template>
