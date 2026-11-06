<script setup lang="ts">
import type { Account } from '../../shared/types'
import { creditSettingsSchema } from '../../shared/credit'
import { toMinor, toMajor, toSignedMinor } from '../../shared/money'
const props = defineProps<{ account?: Account | null }>()
const emit = defineEmits<{ saved: [] }>()
const { workspace: w, command, pending } = useWorkspace()
const form = reactive({
  name: '',
  kind: 'card',
  openingBalance: '0',
  color: 'green',
  bankName: '',
  last4: '',
  inForecast: true,
})
const credit = reactive({ ...creditSettingsSchema.parse({}), limit: '0', minimumPayment: '0' })
const error = ref('')
// Until the user decides, savings stay outside the forecast and other accounts take part.
const forecastTouched = ref(false)
watch(
  () => form.kind,
  (kind) => {
    if (!props.account && !forecastTouched.value)
      form.inForecast = !['savings', 'credit'].includes(kind)
  },
)
watch(
  () => props.account,
  (account) => {
    Object.assign(
      form,
      account
        ? { ...account, openingBalance: toMajor(account.openingBalance) }
        : {
            name: '',
            kind: 'card',
            openingBalance: '0',
            color: 'green',
            bankName: '',
            last4: '',
            inForecast: true,
          },
    )
    const c = creditSettingsSchema.parse(account?.creditSettings || {})
    Object.assign(credit, c, { limit: toMajor(c.limit), minimumPayment: toMajor(c.minimumPayment) })
    forecastTouched.value = false
    error.value = ''
  },
  { immediate: true },
)
async function save() {
  error.value = ''
  try {
    const data = {
      ...form,
      openingBalance: toSignedMinor(form.openingBalance || '0'),
      last4: ['card', 'credit'].includes(form.kind) ? form.last4 : '',
      creditSettings: {
        ...credit,
        limit: toMinor(credit.limit),
        minimumPayment: toMinor(credit.minimumPayment),
        graceUntil: credit.graceUntil || null,
        payerAccountId: credit.payerAccountId || null,
      },
    }
    await command(
      props.account
        ? { op: 'account.update', id: props.account.id, data }
        : { op: 'account.create', data },
      'Счёт сохранён',
    )
    emit('saved')
  } catch (e: any) {
    error.value = e.message
  }
}
</script>
<template>
  <form class="form-stack" @submit.prevent="save">
    <label
      >Название счёта<input
        v-model="form.name"
        required
        maxlength="160"
        placeholder="Например, карта для повседневных трат"
    /></label>
    <div class="form-row">
      <label
        >Тип счёта<select v-model="form.kind">
          <option value="credit">Кредитная карта</option>
          <option value="card">Банковская карта</option>
          <option value="savings">Накопления</option>
          <option value="cash">Наличные</option>
        </select></label
      ><label
        >Банк<input v-model="form.bankName" maxlength="80" placeholder="Название банка"
      /></label>
    </div>
    <label v-if="form.kind === 'card'"
      >Последние 4 цифры карты<input
        v-model="form.last4"
        inputmode="numeric"
        pattern="[0-9]{4}"
        maxlength="4"
        placeholder="1234"
      /><span class="form-hint">Полный номер карты не нужен.</span></label
    >
    <label class="checkbox-row"
      ><input v-model="form.inForecast" type="checkbox" @change="forecastTouched = true" /><span
        >Учитывать в прогнозе<small
          >Деньги этого счёта можно тратить на текущие платежи. Накопления и резервы обычно не
          учитываются: переводы на них прогноз покажет как отток.</small
        ></span
      ></label
    >
    <fieldset v-if="form.kind === 'credit'" class="form-stack">
      <legend>Условия кредитной карты</legend>
      <label>Лимит, ₽<input v-model="credit.limit" inputmode="decimal" required /></label>
      <label
        >Минимальный платёж из выписки, ₽<input
          v-model="credit.minimumPayment"
          inputmode="decimal"
          required
      /></label>
      <label
        >День платежа<input v-model.number="credit.paymentDay" type="number" min="1" max="31"
      /></label>
      <label>Льготный период до<input v-model="credit.graceUntil" type="date" /></label>
      <label><input v-model="credit.payFull" type="checkbox" /> Планировать полное погашение</label>
      <label
        >Счёт погашения<select v-model="credit.payerAccountId">
          <option :value="null">Выбрать при оплате</option>
          <option
            v-for="a in w.accounts.filter((a) => !a.archived && a.kind !== 'credit')"
            :key="a.id"
            :value="a.id"
          >
            {{ a.name }}
          </option>
        </select></label
      >
      <p class="form-hint">
        Долг — отрицательный остаток. Погашение в календаре создаёт перевод на карту. Минимальный
        платёж и льготную дату вводите из выписки банка.
      </p>
    </fieldset>
    <fieldset class="color-picker">
      <legend>Цвет</legend>
      <label
        v-for="color in [
          { id: 'green', label: 'Зелёный' },
          { id: 'blue', label: 'Голубой' },
          { id: 'sand', label: 'Песочный' },
        ]"
        :key="color.id"
        ><input v-model="form.color" type="radio" :value="color.id" name="account-color" /><span
          :class="color.id"
        />{{ color.label }}</label
      >
    </fieldset>
    <details v-if="account" class="opening-balance-details">
      <summary>Исправить начальный остаток</summary>
      <label
        >Начальный остаток, ₽<input v-model="form.openingBalance" inputmode="decimal" required
      /></label>
      <p class="form-hint">
        Изменение исправляет остаток за всю историю. Для сверки на конкретную дату используйте
        «Сверить остаток» в меню счёта.
      </p>
    </details>
    <label v-else
      >Начальный остаток, ₽<input v-model="form.openingBalance" inputmode="decimal" required /><span
        class="form-hint"
        >Остаток до первой операции. Можно указать отрицательную сумму.</span
      ></label
    >
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <button class="button primary full" :disabled="pending">
      {{ pending ? 'Сохраняем…' : account ? 'Сохранить изменения' : 'Добавить счёт' }}
    </button>
  </form>
</template>
