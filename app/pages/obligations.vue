<script setup lang="ts">
import { money, sumAmounts, toMinor, toMajor } from '../../shared/money'
import type { Obligation } from '../../shared/types'
const { workspace: w, command, pending } = useWorkspace()
const open = ref(false),
  error = ref(''),
  deleting = ref<string | null>(null)
const editing = ref<Obligation | null>(null)
function requestDelete() {
  deleting.value = editing.value?.id || null
  open.value = false
}
const form = reactive({
  title: '',
  kind: 'credit',
  remaining: '',
  payment: '',
  dueDay: 10,
  rate: '0',
})
const debt = computed(() =>
  sumAmounts(w.value.obligations.filter((o) => o.kind !== 'receivable').map((o) => o.remaining)),
)
const monthly = computed(() =>
  sumAmounts(
    w.value.obligations
      .filter((o) => o.kind !== 'receivable' && BigInt(o.remaining) > 0n)
      .map((o) => o.payment),
  ),
)
const receivable = computed(() =>
  sumAmounts(w.value.obligations.filter((o) => o.kind === 'receivable').map((o) => o.remaining)),
)
const kinds: Record<string, string> = {
  credit: 'Кредит',
  mortgage: 'Ипотека',
  debt: 'Я должен',
  receivable: 'Мне должны',
}
function create(obligation?: Obligation) {
  editing.value = obligation || null
  Object.assign(
    form,
    obligation
      ? {
          ...obligation,
          remaining: toMajor(obligation.remaining),
          payment: toMajor(obligation.payment),
        }
      : { title: '', kind: 'credit', remaining: '', payment: '', dueDay: 10, rate: '0' },
  )
  error.value = ''
  open.value = true
}
async function save() {
  error.value = ''
  try {
    const data = {
      ...form,
      remaining: toMinor(form.remaining),
      payment: toMinor(form.payment || '0'),
      rate: form.rate.replace(',', '.'),
    }
    await command(
      editing.value
        ? { op: 'obligation.update', id: editing.value.id, data }
        : { op: 'obligation.create', data },
      'Обязательство сохранено',
    )
    open.value = false
  } catch (e: any) {
    error.value = e.message
  }
}
async function remove() {
  try {
    await command({ op: 'obligation.delete', id: deleting.value }, 'Обязательство удалено')
    deleting.value = null
  } catch {}
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">ПОНЯТНЫЕ ОБЯЗАТЕЛЬСТВА — СПОКОЙНЕЕ ЖИЗНЬ</div>
      <h1>Кредиты и долги<span class="title-dot">.</span></h1>
      <p>Знайте, сколько осталось и что предстоит заплатить.</p>
    </div>
    <button class="button primary" @click="create()">
      <AppIcon name="plus" :size="18" />Добавить
    </button>
  </div>
  <div class="summary-strip">
    <div>
      <span>Осталось вернуть</span><strong>{{ money(debt, true) }}</strong>
    </div>
    <div>
      <span>Платежи в месяц</span><strong>{{ money(monthly, true) }}</strong>
    </div>
    <div>
      <span>Мне должны</span><strong class="text-green">{{ money(receivable, true) }}</strong>
    </div>
  </div>
  <div class="obligations-grid">
    <article v-for="o in w.obligations" :key="o.id" class="panel obligation-card">
      <div class="obligation-top">
        <span class="account-symbol" :class="o.kind === 'mortgage' ? 'green' : 'sand'"
          ><AppIcon
            :name="o.kind === 'mortgage' ? 'home' : o.kind === 'receivable' ? 'income' : 'bank'"
            :size="23" /></span
        ><span class="soft-badge">{{ kinds[o.kind] }}</span
        ><button class="icon-button" :aria-label="`Редактировать ${o.title}`" @click="create(o)">
          <AppIcon name="more" :size="16" />
        </button>
      </div>
      <h2>{{ o.title }}</h2>
      <span class="muted small">Остаток обязательства</span
      ><strong class="obligation-amount">{{ money(o.remaining, true) }}</strong>
      <div class="obligation-details">
        <div>
          <span>Платёж в месяц</span><strong>{{ money(o.payment, true) }}</strong>
        </div>
        <div>
          <span>День платежа</span><strong>{{ o.dueDay }}-го числа</strong>
        </div>
        <div>
          <span>Годовая ставка</span><strong>{{ o.rate }}%</strong>
        </div>
      </div>
      <NuxtLink
        :to="{
          path: '/calendar',
          query: { title: o.title, amount: toMajor(o.payment), day: o.dueDay },
        }"
        class="panel-bottom-link"
        >Запланировать платёж <AppIcon name="arrow" :size="15"
      /></NuxtLink>
    </article>
    <div v-if="!w.obligations.length" class="panel empty-state large">
      <AppIcon name="bank" :size="38" /><strong>Все обязательства — на виду</strong>
      <p>Добавьте кредит, ипотеку или личный долг.</p>
      <button class="button secondary" @click="create()">Добавить обязательство</button>
    </div>
  </div>
  <div class="note-card">
    <AppIcon name="file" :size="22" />
    <p>
      Пока это реестр обязательств с текущими остатками. График погашения, досрочные платежи и
      разделение на проценты и основной долг появятся следующим этапом. Записи не списывают деньги
      со счетов.
    </p>
  </div>
  <AppDialog
    v-model="open"
    :title="editing ? 'Редактировать обязательство' : 'Новое обязательство'"
    description="Запишите текущий остаток по данным банка или вашей договорённости."
    ><form class="form-stack" @submit.prevent="save">
      <label
        >Название<input
          v-model="form.title"
          placeholder="Например, ипотека на квартиру"
          required
          maxlength="160" /></label
      ><label
        >Тип<select v-model="form.kind">
          <option v-for="(name, key) in kinds" :key="key" :value="key">{{ name }}</option>
        </select></label
      >
      <div class="form-row">
        <label
          >Остаток долга, ₽<input
            v-model="form.remaining"
            inputmode="decimal"
            required
            placeholder="0,00" /></label
        ><label
          >Платёж в месяц, ₽<input v-model="form.payment" inputmode="decimal" placeholder="0,00"
        /></label>
      </div>
      <div class="form-row">
        <label
          >День платежа<input
            v-model.number="form.dueDay"
            type="number"
            min="1"
            max="31"
            required /></label
        ><label>Ставка, % годовых<input v-model="form.rate" inputmode="decimal" required /></label>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button
          v-if="editing"
          type="button"
          class="button ghost danger-text"
          @click="requestDelete"
        >
          <AppIcon name="delete" :size="16" />Удалить</button
        ><button class="button primary" :disabled="pending">Сохранить</button>
      </div>
    </form></AppDialog
  >
  <AppDialog
    :model-value="!!deleting"
    title="Удалить обязательство?"
    description="Это действие удаляет запись, а не погашает долг."
    @update:model-value="deleting = null"
    ><div class="dialog-actions">
      <button class="button secondary" @click="deleting = null">Отмена</button
      ><button class="button danger" :disabled="pending" @click="remove">Удалить</button>
    </div></AppDialog
  >
</template>
