<script setup lang="ts">
import type { ProjectedPayment } from '../../shared/planning-types'
import { money, localDate } from '../../shared/money'
const props = defineProps<{ payment: ProjectedPayment }>()
const emit = defineEmits<{ pay: [payment: ProjectedPayment] }>()
const { workspace: w, command, pending } = useWorkspace()
const skipOpen = ref(false)
async function skip() {
  try {
    await command(
      {
        op: 'payment.skip',
        recurringId: props.payment.recurringId,
        dueDate: props.payment.dueDate,
        expectedRevision: w.value.revision,
      },
      'Этот платёж пропущен',
    )
    skipOpen.value = false
  } catch {}
}
async function unskip() {
  try {
    await command(
      {
        op: 'payment.unskip',
        recurringId: props.payment.recurringId,
        dueDate: props.payment.dueDate,
        expectedRevision: w.value.revision,
      },
      'Платёж возвращён в план',
    )
  } catch {}
}
async function restore() {
  try {
    await command(
      { op: 'transaction.restore', id: props.payment.transactionId },
      'Связанный расход восстановлен',
    )
  } catch {}
}
</script>
<template>
  <article
    class="payment-item"
    :class="[
      payment.status,
      { overdue: payment.status === 'pending' && payment.dueDate < localDate() },
    ]"
  >
    <div class="payment-item-top">
      <span class="payment-status-icon"
        ><AppIcon
          :name="
            payment.status === 'paid'
              ? 'done'
              : payment.status === 'skipped'
                ? 'close'
                : payment.status === 'deleted'
                  ? 'restore'
                  : 'repeat'
          "
          :size="19"
      /></span>
      <div>
        <span class="event-type">{{
          payment.status === 'paid'
            ? 'Оплачен'
            : payment.status === 'skipped'
              ? 'Пропущен'
              : payment.status === 'deleted'
                ? 'Связанный расход удалён'
                : payment.dueDate < localDate()
                  ? 'Срок прошёл'
                  : 'Повторяющийся платёж'
        }}</span
        ><strong>{{ payment.title }}</strong
        ><span class="payment-category"
          >{{ payment.category }} ·
          {{ new Date(payment.dueDate + 'T12:00:00').toLocaleDateString('ru-RU') }}</span
        >
      </div>
      <strong class="payment-item-amount">{{
        money(payment.status === 'paid' ? payment.actualAmount || payment.amount : payment.amount)
      }}</strong>
    </div>
    <p v-if="payment.note" class="payment-note">{{ payment.note }}</p>
    <div class="payment-item-actions">
      <template v-if="payment.status === 'pending'"
        ><button
          class="button primary small-button"
          :disabled="pending"
          :aria-label="`Оплатил ${payment.title}`"
          @click="emit('pay', payment)"
        >
          Оплатил</button
        ><button
          class="text-button"
          :disabled="pending"
          :aria-label="`Пропустить ${payment.title}`"
          @click="skipOpen = true"
        >
          Пропустить
        </button></template
      ><button
        v-else-if="payment.status === 'skipped'"
        class="text-button"
        :disabled="pending"
        @click="unskip"
      >
        Вернуть в план</button
      ><button
        v-else-if="payment.status === 'deleted'"
        class="button secondary small-button"
        :disabled="pending"
        @click="restore"
      >
        <AppIcon name="restore" :size="14" />Восстановить расход</button
      ><NuxtLink
        v-if="payment.status === 'paid'"
        :to="{ path: '/transactions', query: { transaction: payment.transactionId } }"
        class="text-button"
        >Расход от
        {{
          new Date((payment.actualDate || payment.dueDate) + 'T12:00:00').toLocaleDateString(
            'ru-RU',
          )
        }}
        <AppIcon name="arrow" :size="14"
      /></NuxtLink>
    </div>
  </article>
  <AppDialog v-model="skipOpen" title="Пропустить этот платёж?" :description="payment.title"
    ><p class="form-hint">
      Пропуск относится только к этой дате. Расписание продолжит действовать, расход не создаётся.
      Платёж можно вернуть в план.
    </p>
    <div class="dialog-actions">
      <button class="button secondary" @click="skipOpen = false">Отмена</button
      ><button class="button primary" :disabled="pending" @click="skip">Пропустить дату</button>
    </div></AppDialog
  >
</template>
