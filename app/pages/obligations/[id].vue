<script setup lang="ts">
import type { ObligationEntry } from '../../../shared/types'
import { localDate, money, toMajor, toMinor } from '../../../shared/money'
import { addDays, isOpen, projectPlans } from '../../../shared/planning'
import { isReceivable, obligationKinds, obligationOutlook } from '../../../shared/obligations'
const route = useRoute()
const { workspace: w, command, pending, loading } = useWorkspace()
const today = localDate()
const obligation = computed(() => w.value.obligations.find((o) => o.id === route.params.id))
const outlook = computed(() => obligation.value && obligationOutlook(obligation.value, w.value))
const receivable = computed(() => !!obligation.value && isReceivable(obligation.value))
const formatDate = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
  })
const monthYear = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })

const transactions = computed(
  () => new Map([...w.value.transactions, ...w.value.deletedTransactions].map((t) => [t.id, t])),
)
const history = computed(() =>
  w.value.obligationEntries
    .filter((e) => e.obligationId === obligation.value?.id)
    .map((e) => {
      const t = e.transactionId ? transactions.value.get(e.transactionId) : undefined
      return {
        e,
        t,
        total: BigInt(e.principal) + BigInt(e.interest) + BigInt(e.fees),
        deleted: !!t?.deletedAt,
        account: t ? w.value.accounts.find((a) => a.id === t.accountId)?.name : undefined,
      }
    }),
)
const upcoming = computed(() => {
  const plan = outlook.value?.plan
  if (!plan || !obligation.value) return []
  return projectPlans(w.value, obligation.value.startDate, addDays(today, 62)).filter(
    (d) => d.planId === plan.id && isOpen(d),
  )
})
const showAll = ref(false)
const schedule = computed(() => {
  const rows = outlook.value?.schedule || []
  return showAll.value ? rows : rows.slice(0, 12)
})

const editing = ref(false),
  deleting = ref(false),
  paying = ref(false),
  payDate = ref<string | null>(null),
  editingEntry = ref<ObligationEntry | null>(null),
  cancelling = ref<ObligationEntry | null>(null),
  deleteTransaction = ref(true),
  reconciling = ref(false)
function askCancel(entry: ObligationEntry) {
  cancelling.value = entry
  deleteTransaction.value = true
}
function askDelete() {
  editing.value = false
  deleting.value = true
}
function closePayment() {
  paying.value = false
  editingEntry.value = null
}
function pay(dueDate: string | null = null) {
  payDate.value = dueDate
  paying.value = true
}
async function cancel() {
  if (!cancelling.value) return
  try {
    await command(
      {
        op: 'obligation.payment.cancel',
        id: cancelling.value.id,
        expectedRevision: w.value.revision,
        deleteTransaction: cancelling.value.kind === 'payment' && deleteTransaction.value,
      },
      cancelling.value.kind === 'payment' ? 'Платёж отменён' : 'Сверка отменена',
    )
    cancelling.value = null
  } catch {}
}
async function remove() {
  try {
    await command({ op: 'obligation.delete', id: obligation.value!.id }, 'Обязательство удалено')
    deleting.value = false
    await navigateTo('/obligations')
  } catch {}
}

const reconcile = reactive({ date: today, actual: '', note: '', expected: '', error: '' })
function openReconcile() {
  Object.assign(reconcile, {
    date: today,
    actual: toMajor(outlook.value!.remaining.toString()),
    note: '',
    expected: outlook.value!.remaining.toString(),
    error: '',
  })
  reconciling.value = true
}
const reconcileDelta = computed(() => {
  try {
    return BigInt(toMinor(reconcile.actual || '0')) - BigInt(reconcile.expected || '0')
  } catch {
    return null
  }
})
async function saveReconcile() {
  reconcile.error = ''
  try {
    await command(
      {
        op: 'obligation.reconcile',
        id: obligation.value!.id,
        expectedRevision: w.value.revision,
        date: reconcile.date,
        actual: toMinor(reconcile.actual),
        expected: reconcile.expected,
        note: reconcile.note,
      },
      reconcileDelta.value ? 'Остаток исправлен по выписке' : 'Остаток совпадает с банком',
    )
    reconciling.value = false
  } catch (e: any) {
    reconcile.error = e.message
  }
}
const entryLabel = (e: ObligationEntry) =>
  e.kind === 'adjustment'
    ? 'Сверка с банком'
    : e.early === 'term'
      ? 'Досрочно · сокращён срок'
      : e.early === 'payment'
        ? 'Досрочно · уменьшен платёж'
        : receivable.value
          ? 'Возврат'
          : 'Платёж'
</script>
<template>
  <div v-if="!obligation" class="panel empty-state large">
    <template v-if="!loading">
      <AppIcon name="bank" :size="38" /><strong>Обязательство не найдено</strong>
      <p>Возможно, его удалили в другой вкладке.</p>
      <NuxtLink to="/obligations" class="button secondary">Ко всем обязательствам</NuxtLink>
    </template>
  </div>
  <template v-else-if="outlook">
    <NuxtLink to="/obligations" class="back-link"
      ><AppIcon name="arrow" :size="14" class="flip" />Кредиты и долги</NuxtLink
    >
    <div class="page-heading">
      <div>
        <div class="eyebrow">{{ obligationKinds[obligation.kind].toUpperCase() }}</div>
        <h1>{{ obligation.title }}<span class="title-dot">.</span></h1>
        <p>
          Учёт с {{ formatDate(obligation.startDate) }} · {{ obligation.rate }}% годовых
          <template v-if="BigInt(obligation.payment) > 0n">
            · {{ money(obligation.payment) }} {{ obligation.dueDay }}-го числа</template
          >
        </p>
      </div>
      <div class="heading-actions">
        <button class="button secondary" @click="editing = true">
          <AppIcon name="edit" :size="16" />Изменить</button
        ><button class="button secondary" @click="openReconcile">
          <AppIcon name="done" :size="16" />Сверить</button
        ><button v-if="outlook.remaining > 0n" class="button primary" @click="pay()">
          <AppIcon name="plus" :size="16" />{{ receivable ? 'Возврат' : 'Платёж' }}
        </button>
      </div>
    </div>

    <div class="summary-strip">
      <div>
        <span>{{ receivable ? 'Ещё должны' : 'Остаток долга' }}</span
        ><strong>{{ money(outlook.remaining) }}</strong>
      </div>
      <div>
        <span>{{ receivable ? 'Вернули' : 'Погашено основного долга' }}</span
        ><strong class="text-green">{{ money(outlook.paidPrincipal) }}</strong>
      </div>
      <div v-if="!receivable">
        <span>Уплачено процентов и комиссий</span
        ><strong>{{ money(outlook.paidInterest + outlook.paidFees) }}</strong>
      </div>
      <div>
        <span>Погашение по расчёту</span
        ><strong>{{
          outlook.remaining <= 0n
            ? 'Завершено'
            : outlook.payoff
              ? monthYear(outlook.payoff)
              : BigInt(obligation.payment) > 0n
                ? 'Платёж не покрывает проценты'
                : 'Без графика'
        }}</strong>
      </div>
    </div>

    <div class="obligation-layout">
      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Ближайшие платежи</h2>
            <p>По графику — в календаре и прогнозе</p>
          </div>
        </div>
        <ul v-if="upcoming.length" class="obligation-upcoming">
          <li v-for="d in upcoming" :key="d.dueDate">
            <span
              ><strong :class="{ 'danger-text': d.date < today }">{{ formatDate(d.date) }}</strong
              ><small>{{
                d.date < today ? 'Срок прошёл' : d.movedTo ? 'Перенесено' : 'По графику'
              }}</small></span
            ><b>{{ money(d.amount) }}</b
            ><button class="text-button" :disabled="pending" @click="pay(d.dueDate)">
              {{ receivable ? 'Получено' : 'Оплатить' }}
            </button>
          </li>
        </ul>
        <p v-else class="obligation-empty">
          {{
            outlook.remaining <= 0n
              ? 'Долг погашен — новых платежей нет.'
              : 'Нет платежа в месяц: записывайте платежи по мере оплаты.'
          }}
        </p>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>История</h2>
            <p>Платежи, досрочные погашения и сверки с банком</p>
          </div>
        </div>
        <div v-if="history.length" class="obligation-history">
          <div
            v-for="h in history"
            :key="h.e.id"
            class="obligation-entry"
            :class="{ deleted: h.deleted }"
          >
            <span class="entry-main"
              ><strong>{{ entryLabel(h.e) }}</strong
              ><small
                >{{ formatDate(h.e.date) }}{{ h.account ? ` · ${h.account}` : ''
                }}{{ h.e.note ? ` · ${h.e.note}` : '' }}</small
              ><em v-if="h.deleted" class="danger-text"
                >Операция удалена — платёж не учитывается.
                <NuxtLink to="/transactions">Восстановить</NuxtLink></em
              ></span
            >
            <span class="entry-amount">
              <template v-if="h.e.kind === 'adjustment'"
                ><b
                  >{{ BigInt(h.e.principal) > 0n ? '+' : '−'
                  }}{{
                    money(BigInt(h.e.principal) > 0n ? h.e.principal : h.e.principal.slice(1))
                  }}</b
                ><small>к остатку</small></template
              >
              <template v-else
                ><b>{{ money(h.total) }}</b
                ><small
                  >долг {{ money(h.e.principal)
                  }}{{ BigInt(h.e.interest) ? ` · % ${money(h.e.interest)}` : ''
                  }}{{ BigInt(h.e.fees) ? ` · ком. ${money(h.e.fees)}` : '' }}</small
                ></template
              >
            </span>
            <span class="entry-actions"
              ><button
                v-if="h.e.kind === 'payment' && !h.deleted"
                class="icon-button"
                :aria-label="`Изменить платёж ${formatDate(h.e.date)}`"
                @click="editingEntry = h.e"
              >
                <AppIcon name="edit" :size="15" /></button
              ><button
                class="icon-button"
                :aria-label="`Отменить: ${entryLabel(h.e)} ${formatDate(h.e.date)}`"
                @click="askCancel(h.e)"
              >
                <AppIcon name="close" :size="15" /></button
            ></span>
          </div>
        </div>
        <p v-else class="obligation-empty">
          Платежей ещё нет. Остаток на {{ formatDate(obligation.startDate) }} —
          {{ money(obligation.openingBalance) }}.
        </p>
      </section>
    </div>

    <section v-if="outlook.schedule.length" class="panel forecast-section">
      <div class="panel-heading">
        <div>
          <h2>Расчётный график</h2>
          <p>
            Платежей до погашения: {{ outlook.schedule.length }}, проценты по расчёту —
            {{ money(outlook.futureInterest) }}
          </p>
        </div>
      </div>
      <div class="forecast-table" role="table" aria-label="Расчётный график платежей">
        <div class="forecast-row schedule-row head" role="row">
          <span role="columnheader">Дата</span><span role="columnheader">Платёж</span
          ><span role="columnheader">Проценты</span><span role="columnheader">Основной долг</span
          ><span role="columnheader">Остаток</span>
        </div>
        <div v-for="row in schedule" :key="row.date" class="forecast-row schedule-row" role="row">
          <span role="cell"
            ><strong>{{ formatDate(row.date) }}</strong></span
          ><span role="cell" data-label="Платёж">{{ money(row.payment) }}</span
          ><span role="cell" data-label="Проценты">{{ money(row.interest) }}</span
          ><span role="cell" data-label="Основной долг">{{ money(row.principal) }}</span
          ><span role="cell" data-label="Остаток">{{ money(row.remaining) }}</span>
        </div>
      </div>
      <div class="forecast-note">
        <button v-if="outlook.schedule.length > 12" class="text-button" @click="showAll = !showAll">
          {{ showAll ? 'Свернуть' : `Показать все ${outlook.schedule.length}` }}
        </button>
        <p class="form-hint">
          Расчёт: проценты за месяц — остаток × ставка / 12, последний платёж меньше. Банк считает
          проценты по дням, поэтому суммы отличаются на рубли; фактические проценты указывайте при
          записи платежа, а остаток поправит сверка.
        </p>
      </div>
    </section>

    <AppDialog v-model="editing" title="Изменить обязательство"
      ><ObligationForm
        v-if="editing"
        :obligation="obligation"
        @saved="editing = false"
        @remove="askDelete"
    /></AppDialog>
    <AppDialog
      :model-value="paying || !!editingEntry"
      :title="editingEntry ? 'Изменить платёж' : receivable ? 'Записать возврат' : 'Внести платёж'"
      :description="obligation.title"
      @update:model-value="closePayment"
      ><ObligationPaymentForm
        v-if="paying || editingEntry"
        :obligation="obligation"
        :entry="editingEntry"
        :due-date="payDate"
        @saved="closePayment"
    /></AppDialog>
    <AppDialog
      :model-value="!!cancelling"
      :title="cancelling?.kind === 'adjustment' ? 'Отменить сверку?' : 'Отменить платёж?'"
      :description="
        cancelling?.kind === 'adjustment'
          ? 'Остаток вернётся к расчётному.'
          : 'Остаток долга увеличится обратно, дата графика снова будет ждать оплаты.'
      "
      @update:model-value="cancelling = null"
    >
      <label v-if="cancelling?.kind === 'payment'" class="checkbox-row"
        ><input v-model="deleteTransaction" type="checkbox" /><span
          >Удалить и операцию<small
            >Снимите, если деньги действительно ушли, но не на этот долг: операция останется обычным
            {{ receivable ? 'доходом' : 'расходом' }}. Удалённую операцию можно восстановить.</small
          ></span
        ></label
      >
      <p v-if="cancelling?.early === 'payment'" class="form-hint">
        Платёж в месяц вернётся к прежнему, если после этого не было других досрочных погашений с
        уменьшением платежа.
      </p>
      <div class="dialog-actions">
        <button class="button secondary" @click="cancelling = null">Не отменять</button
        ><button class="button danger" :disabled="pending" @click="cancel">Отменить</button>
      </div>
    </AppDialog>
    <AppDialog
      v-model="reconciling"
      title="Сверить остаток с банком"
      description="Укажите остаток основного долга из выписки или приложения банка."
    >
      <form class="form-stack" @submit.prevent="saveReconcile">
        <div class="form-row">
          <label
            >Дата выписки<input
              v-model="reconcile.date"
              type="date"
              :min="obligation.startDate"
              :max="today"
              required /></label
          ><label
            >Остаток по банку, ₽<input v-model="reconcile.actual" inputmode="decimal" required
          /></label>
        </div>
        <div class="payment-split">
          <div>
            <span>По учёту в «Ладе»</span><strong>{{ money(reconcile.expected || '0') }}</strong>
          </div>
          <div>
            <span>Поправка</span
            ><strong>{{
              reconcileDelta === null
                ? '—'
                : reconcileDelta === 0n
                  ? 'Совпадает'
                  : `${reconcileDelta > 0n ? '+' : '−'}${money(reconcileDelta > 0n ? reconcileDelta : -reconcileDelta)}`
            }}</strong>
          </div>
        </div>
        <p class="form-hint">
          Поправка сохраняется в истории отдельно от платежей и не меняет счета: она исправляет
          только остаток долга.
        </p>
        <label
          >Заметка<input v-model="reconcile.note" maxlength="300" placeholder="Сверка с банком"
        /></label>
        <p v-if="reconcile.error" class="form-error" role="alert">{{ reconcile.error }}</p>
        <button class="button primary full" :disabled="pending">Сохранить сверку</button>
      </form>
    </AppDialog>
    <AppDialog
      v-model="deleting"
      title="Удалить обязательство?"
      description="Удаляется запись и её график платежей. Если есть история погашений, сначала отмените их."
      ><div class="dialog-actions">
        <button class="button secondary" @click="deleting = false">Отмена</button
        ><button class="button danger" :disabled="pending" @click="remove">Удалить</button>
      </div></AppDialog
    >
  </template>
</template>
