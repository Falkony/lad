<script setup lang="ts">
import type { Transaction } from '../../shared/types'
import { money } from '../../shared/money'
defineProps<{ transactions: Transaction[]; deletable?: boolean; selectable?: boolean }>()
const selected = defineModel<string[]>('selected', { default: () => [] })
const { workspace, command, pending } = useWorkspace()
const removing = ref<string | null>(null)
const editing = ref<Transaction | null>(null)
function toggle(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((value) => value !== id)
    : [...selected.value, id]
}
async function restore(id: string) {
  try {
    await command({ op: 'transaction.restore', id }, 'Операция восстановлена')
  } catch {}
}
const categoryIcons: Record<string, string> = {
  Продукты: 'shopping',
  Дом: 'home',
  Транспорт: 'car',
  Здоровье: 'health',
  Развлечения: 'cinema',
  Покупки: 'bag',
  Кафе: 'coffee',
  Подписки: 'card',
  Зарплата: 'income',
}
function dateLabel(date: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(
    new Date(date + 'T12:00:00'),
  )
}
async function remove(id: string) {
  try {
    await command({ op: 'transaction.delete', id }, 'Операция удалена')
    removing.value = null
  } catch {}
}
</script>
<template>
  <div class="transaction-list">
    <div v-for="t in transactions" :key="t.id" class="transaction-row">
      <input
        v-if="selectable && ['expense', 'income'].includes(t.kind)"
        type="checkbox"
        class="transaction-select"
        :aria-label="`Выбрать ${t.description || t.category}`"
        :checked="selected.includes(t.id)"
        @change="toggle(t.id)"
      />
      <div class="category-icon" :class="t.kind === 'income' ? 'income' : t.category">
        <AppIcon
          :name="
            ['transfer', 'adjustment'].includes(t.kind)
              ? t.kind
              : categoryIcons[t.category] || 'wallet'
          "
          :size="19"
        />
      </div>
      <div class="transaction-description">
        <strong>{{ t.description || t.category }}</strong
        ><span
          >{{ t.category }}<span class="dot-separator">·</span
          >{{ workspace.accounts.find((a) => a.id === t.accountId)?.name
          }}<template v-if="t.kind === 'transfer'">
            → {{ workspace.accounts.find((a) => a.id === t.toAccountId)?.name }}</template
          ></span
        >
      </div>
      <div class="transaction-value">
        <strong :class="{ 'text-green': t.kind === 'income' }"
          >{{ t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : ''
          }}{{ money(t.amount) }}</strong
        ><span>{{ dateLabel(t.date) }}</span>
      </div>
      <span
        v-if="t.kind === 'adjustment'"
        class="adjustment-label"
        title="Создана сверкой, не учитывается в доходах и расходах"
        >Сверка</span
      >
      <button
        v-if="!t.deletedAt && t.kind !== 'adjustment'"
        class="icon-button transaction-edit"
        :aria-label="`Редактировать операцию ${t.description || t.category}`"
        @click="editing = t"
      >
        <AppIcon name="edit" :size="16" />
      </button>
      <button
        v-if="t.deletedAt"
        class="button secondary small-button"
        :disabled="pending"
        :aria-label="`Восстановить операцию ${t.description || t.category}`"
        @click="restore(t.id)"
      >
        <AppIcon name="restore" :size="15" /><span class="restore-label">Восстановить</span>
      </button>
      <button
        v-if="deletable && !t.deletedAt"
        class="icon-button delete-hover"
        aria-label="Удалить операцию"
        @click="removing = t.id"
      >
        <AppIcon name="delete" :size="16" />
      </button>
    </div>
    <div v-if="!transactions.length" class="empty-state">
      <AppIcon name="wallet" :size="30" /><strong>Пока нет операций</strong>
      <p>Запишите первый расход или загрузите выписку.</p>
    </div>
  </div>
  <AppDialog
    :model-value="!!removing"
    title="Удалить операцию?"
    description="Баланс счёта будет пересчитан. Операцию можно восстановить во вкладке «Удалённые»."
    @update:model-value="removing = null"
    ><div class="dialog-actions">
      <button class="button secondary" @click="removing = null">Отмена</button
      ><button class="button danger" :disabled="pending" @click="remove(removing!)">Удалить</button>
    </div></AppDialog
  >
  <AppDialog
    :model-value="!!editing"
    title="Редактировать операцию"
    description="Изменения сразу пересчитают остатки связанных счетов."
    @update:model-value="editing = null"
    ><TransactionForm v-if="editing" :transaction="editing" @saved="editing = null"
  /></AppDialog>
</template>
