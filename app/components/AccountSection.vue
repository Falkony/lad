<script setup lang="ts">
import type { Account } from '../../shared/types'
import { accountBalance, money, sumAmounts } from '../../shared/money'
defineProps<{ full?: boolean }>()
const { workspace: w, command, pending } = useWorkspace()
const open = ref(false),
  editing = ref<Account | null>(null),
  reconciling = ref<Account | null>(null),
  action = ref<{ account: Account; kind: 'archive' | 'delete' } | null>(null),
  filter = ref('active')
const active = computed(() => w.value.accounts.filter((a) => !a.archived)),
  archived = computed(() => w.value.accounts.filter((a) => a.archived))
const balance = (account: Account) => accountBalance(account, w.value.transactions)
const total = (accounts: Account[]) => sumAmounts(accounts.map(balance))
function edit(account?: Account) {
  editing.value = account || null
  open.value = true
}
function hasHistory(account: Account) {
  return (
    [
      ...w.value.recurringPayments,
      ...w.value.recurringVersions,
      ...w.value.paymentOccurrences,
    ].some((r) => r.accountId === account.id) ||
    [...w.value.transactions, ...w.value.deletedTransactions].some((t) =>
      [t.accountId, t.toAccountId, t.importAccountId].includes(account.id),
    )
  )
}
function canDelete(account: Account) {
  return !hasHistory(account) && BigInt(account.openingBalance) === 0n
}
function closeMenu(event: Event) {
  const details = (event.target as HTMLElement).closest('details')
  if (details) details.open = false
}
async function confirmAction() {
  if (!action.value) return
  try {
    const { account, kind } = action.value
    await command(
      kind === 'archive'
        ? { op: 'account.archive', id: account.id, archived: !account.archived }
        : { op: 'account.delete', id: account.id },
      kind === 'archive'
        ? account.archived
          ? 'Счёт возвращён из архива'
          : 'Счёт перенесён в архив'
        : 'Пустой счёт удалён',
    )
    action.value = null
  } catch {}
}
</script>
<template>
  <section class="accounts-section">
    <div v-if="full" class="summary-strip">
      <div>
        <span>Действующие счета</span><strong>{{ money(total(active)) }}</strong>
      </div>
      <div>
        <span>В архиве</span><strong>{{ money(total(archived)) }}</strong>
      </div>
      <div>
        <span>Общий остаток</span><strong>{{ money(total(w.accounts)) }}</strong>
      </div>
    </div>
    <div class="inline-heading">
      <h2>
        {{ full ? 'Все счета' : 'Мои счета' }}
        <span class="count-label">{{ active.length }} действующих</span>
      </h2>
      <div class="heading-actions">
        <NuxtLink v-if="!full" to="/accounts" class="text-button"
          >Все счета <AppIcon name="arrow" :size="14" /></NuxtLink
        ><button class="button secondary small-button" @click="edit()">
          <AppIcon name="plus" :size="15" />Добавить счёт
        </button>
      </div>
    </div>
    <div v-if="full" class="account-tabs">
      <button :class="{ selected: filter === 'active' }" @click="filter = 'active'">
        Действующие · {{ active.length }}</button
      ><button :class="{ selected: filter === 'archived' }" @click="filter = 'archived'">
        Архив · {{ archived.length }}
      </button>
    </div>
    <div class="managed-accounts-grid">
      <article
        v-for="account in (full && filter === 'archived' ? archived : active).slice(
          0,
          full ? undefined : 3,
        )"
        :key="account.id"
        class="managed-account-card"
        :class="account.color"
      >
        <div class="managed-account-top">
          <span class="account-symbol" :class="account.color"
            ><AppIcon :name="account.kind" :size="22" /></span
          ><span class="account-bank"
            >{{
              account.bankName ||
              (account.kind === 'cash'
                ? 'Наличные'
                : account.kind === 'savings'
                  ? 'Накопления'
                  : 'Банковская карта')
            }}{{ account.last4 ? ` · •• ${account.last4}` : '' }}</span
          >
          <details class="account-menu">
            <summary role="button" :aria-label="`Действия со счётом ${account.name}`">
              <AppIcon name="more" :size="20" />
            </summary>
            <div class="account-menu-items" @click="closeMenu">
              <button @click="edit(account)"><AppIcon name="edit" :size="15" />Редактировать</button
              ><NuxtLink :to="{ path: '/transactions', query: { account: account.id } }"
                ><AppIcon name="wallet" :size="15" />Операции счёта</NuxtLink
              ><button v-if="!account.archived" @click="reconciling = account">
                <AppIcon name="refresh" :size="15" />Сверить остаток</button
              ><button @click="action = { account, kind: 'archive' }">
                <AppIcon name="archive" :size="15" />{{
                  account.archived ? 'Вернуть из архива' : 'Архивировать'
                }}</button
              ><button
                :disabled="!canDelete(account)"
                :title="
                  canDelete(account)
                    ? 'Удалить пустой счёт'
                    : 'Удаление доступно только для счёта без истории и с нулевым остатком'
                "
                class="danger-text"
                @click="action = { account, kind: 'delete' }"
              >
                <AppIcon name="delete" :size="15" />Удалить пустой счёт
              </button>
            </div>
          </details>
        </div>
        <h3>{{ account.name }}</h3>
        <strong class="managed-account-balance">{{ money(balance(account)) }}</strong>
        <div class="managed-account-footer">
          <span>{{ account.archived ? 'В архиве' : 'RUB' }}</span
          ><button
            class="text-button account-edit-button"
            :aria-label="`Редактировать счёт ${account.name}`"
            @click="edit(account)"
          >
            <AppIcon name="edit" :size="14" />Редактировать
          </button>
        </div>
      </article>
    </div>
    <div
      v-if="!(full && filter === 'archived' ? archived : active).length"
      class="empty-state panel"
    >
      <AppIcon name="wallet" :size="30" /><strong>{{
        full && filter === 'archived' ? 'Архив пуст' : 'Пока нет действующих счетов'
      }}</strong>
      <p>
        {{
          full && filter === 'archived'
            ? 'Здесь сохраняется история закрытых счетов.'
            : 'Добавьте карту, наличные или накопления.'
        }}
      </p>
      <button v-if="filter !== 'archived' || !full" class="button secondary" @click="edit()">
        Добавить счёт
      </button>
    </div>
    <p v-if="archived.length && !full" class="form-hint account-archive-note">
      В общем остатке учитываются и архивные счета.
      <NuxtLink to="/accounts">Посмотреть архив</NuxtLink>
    </p>
  </section>
  <AppDialog
    v-model="open"
    :title="editing ? 'Редактировать счёт' : 'Добавить счёт'"
    description="Настройте счёт так, чтобы легко узнавать его в списке."
    ><AccountForm :account="editing" @saved="open = false"
  /></AppDialog>
  <AppDialog
    :model-value="!!reconciling"
    title="Сверить остаток"
    :description="reconciling?.name"
    @update:model-value="reconciling = null"
    ><ReconcileForm v-if="reconciling" :account="reconciling" @saved="reconciling = null"
  /></AppDialog>
  <AppDialog
    :model-value="!!action"
    :title="
      action?.kind === 'delete'
        ? 'Удалить пустой счёт?'
        : action?.account.archived
          ? 'Вернуть счёт из архива?'
          : 'Архивировать счёт?'
    "
    :description="action?.account.name"
    @update:model-value="action = null"
    ><div class="form-stack">
      <p class="form-hint">
        {{
          action?.kind === 'delete'
            ? 'У этого счёта нет операций и остатка.'
            : action?.account.archived
              ? 'Счёт снова станет доступен для новых операций.'
              : 'История и остаток сохранятся. Счёт исчезнет из выбора для новых операций; его деньги останутся в общем балансе.'
        }}
      </p>
      <div class="dialog-actions">
        <button class="button secondary" @click="action = null">Отмена</button
        ><button
          class="button"
          :class="action?.kind === 'delete' ? 'danger' : 'primary'"
          :disabled="pending"
          @click="confirmAction"
        >
          {{
            action?.kind === 'delete'
              ? 'Удалить счёт'
              : action?.account.archived
                ? 'Вернуть из архива'
                : 'Архивировать'
          }}
        </button>
      </div>
    </div></AppDialog
  >
</template>
