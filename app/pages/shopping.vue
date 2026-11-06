<script setup lang="ts">
import { money, toMinor, toMajor, sumAmounts, localDate } from '../../shared/money'
const { workspace: w, command, pending } = useWorkspace()
const title = ref(''),
  quantity = ref(''),
  price = ref(''),
  error = ref(''),
  open = ref(false),
  amount = ref(''),
  accountId = ref(''),
  deleting = ref<string | null>(null)
const selected = computed(() => w.value.shopping.filter((x) => x.checked))
const total = computed(() => sumAmounts(w.value.shopping.map((x) => x.price)))
const selectedTotal = computed(() => sumAmounts(selected.value.map((x) => x.price)))
const sorted = computed(() =>
  [...w.value.shopping].sort((a, b) => Number(a.checked) - Number(b.checked)),
)
async function add() {
  error.value = ''
  try {
    await command({
      op: 'shopping.create',
      data: {
        title: title.value,
        quantity: quantity.value || '1 шт.',
        price: toMinor(price.value || '0'),
      },
    })
    title.value = ''
    quantity.value = ''
    price.value = ''
  } catch (e: any) {
    error.value = e.message
  }
}
async function toggle(id: string, checked: boolean) {
  try {
    await command({ op: 'shopping.toggle', id, checked })
  } catch {}
}
async function remove() {
  try {
    await command({ op: 'shopping.delete', id: deleting.value }, 'Товар удалён')
    deleting.value = null
  } catch {}
}
function checkout() {
  amount.value = toMajor(selectedTotal.value)
  accountId.value = w.value.accounts.find((a) => !a.archived)?.id || ''
  error.value = ''
  open.value = true
}
async function pay() {
  error.value = ''
  try {
    await command(
      {
        op: 'shopping.checkout',
        data: { accountId: accountId.value, amount: toMinor(amount.value), date: localDate() },
      },
      'Покупка записана в расходы',
    )
    open.value = false
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">САМОЕ НУЖНОЕ ДЛЯ ДОМА</div>
      <h1>В магазин с ясной головой<span class="title-dot">.</span></h1>
      <p>Ничего не забыть. Не купить лишнего.</p>
    </div>
    <span class="page-illustration"><AppIcon name="shopping" :size="45" /></span>
  </div>
  <div class="shopping-layout">
    <section class="panel shopping-panel">
      <div class="panel-heading">
        <div>
          <h2>
            Список покупок <span class="count-label">{{ w.shopping.length }}</span>
          </h2>
          <p>Отмечайте товары по мере покупки</p>
        </div>
        <span class="soft-badge green">{{ selected.length }} в корзине</span>
      </div>
      <form class="shopping-add-form" @submit.prevent="add">
        <input
          v-model="title"
          placeholder="Что нужно купить?"
          aria-label="Название товара"
          required
          maxlength="160"
        /><input
          v-model="quantity"
          placeholder="Кол-во"
          aria-label="Количество"
          maxlength="40"
        /><input
          v-model="price"
          placeholder="Сумма, ₽"
          aria-label="Примерная сумма за весь товар"
          inputmode="decimal"
        /><button class="button primary" :disabled="pending" aria-label="Добавить товар">
          <AppIcon name="plus" :size="20" />
        </button>
      </form>
      <p v-if="error && !open" class="form-error shopping-form-error" role="alert">{{ error }}</p>
      <div
        v-for="item in sorted"
        :key="item.id"
        class="shopping-row"
        :class="{ purchased: item.checked }"
      >
        <button
          class="check-box"
          :class="{ checked: item.checked }"
          :aria-label="`${item.checked ? 'Вернуть в список' : 'Отметить купленным'}: ${item.title}`"
          :disabled="pending"
          @click="toggle(item.id, !item.checked)"
        >
          <AppIcon v-if="item.checked" name="check" :size="13" />
        </button>
        <div class="shopping-item-title">
          <strong>{{ item.title }}</strong
          ><span>{{ item.quantity }}</span>
        </div>
        <strong class="shopping-price">{{
          BigInt(item.price) > 0n ? money(item.price) : '—'
        }}</strong
        ><button
          class="icon-button"
          :aria-label="`Удалить ${item.title}`"
          @click="deleting = item.id"
        >
          <AppIcon name="delete" :size="16" />
        </button>
      </div>
      <div v-if="!w.shopping.length" class="empty-state large">
        <AppIcon name="shopping" :size="38" /><strong>В списке пока ничего нет</strong>
        <p>Добавьте продукты и нужные мелочи для дома.</p>
      </div>
    </section>
    <aside>
      <div class="shopping-summary">
        <span class="eyebrow">ВАША КОРЗИНА</span>
        <h2>Покупки без сюрпризов</h2>
        <div class="shopping-total">
          <span>Примерно за весь список</span><strong>{{ money(total) }}</strong>
        </div>
        <div class="shopping-selected">
          <span>В корзине · {{ selected.length }} позиций</span
          ><strong>{{ money(selectedTotal) }}</strong>
        </div>
        <p>
          Указывайте примерную сумму за всю позицию с учётом количества. После покупки внесите сумму
          чека.
        </p>
        <button
          class="button primary full"
          :disabled="!selected.length || pending"
          @click="checkout"
        >
          <AppIcon name="check" :size="17" />Записать покупку
        </button>
      </div>
      <div class="note-card shopping-note">
        <AppIcon name="sprout" :size="23" />
        <p>Отмеченные товары превратятся в один расход «Продукты» и исчезнут из списка.</p>
      </div>
    </aside>
  </div>
  <AppDialog
    v-model="open"
    title="Записать покупку"
    description="Укажите фактическую сумму чека. Мы добавим один расход и уберём купленные товары из списка."
    ><form class="form-stack" @submit.prevent="pay">
      <div class="checkout-items">
        <span v-for="item in selected" :key="item.id">{{ item.title }} · {{ item.quantity }}</span>
      </div>
      <label
        >Сумма чека, ₽<input
          v-model="amount"
          class="amount-input"
          inputmode="decimal"
          required /></label
      ><label
        >Счёт списания<select v-model="accountId" required>
          <option value="" disabled>Выберите счёт</option>
          <option v-for="a in w.accounts.filter((a) => !a.archived)" :key="a.id" :value="a.id">
            {{ a.name }}
          </option>
        </select></label
      >
      <p v-if="!w.accounts.some((a) => !a.archived)" class="form-hint">
        Добавьте счёт в разделе «Обзор».
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button
        class="button primary full"
        :disabled="pending || !w.accounts.some((a) => !a.archived)"
      >
        Сохранить расход
      </button>
    </form></AppDialog
  >
  <AppDialog
    :model-value="!!deleting"
    title="Удалить товар из списка?"
    @update:model-value="deleting = null"
    ><div class="dialog-actions">
      <button class="button secondary" @click="deleting = null">Отмена</button
      ><button class="button danger" :disabled="pending" @click="remove">Удалить</button>
    </div></AppDialog
  >
</template>
