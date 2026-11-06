<script setup lang="ts">
import type { Account } from '../../shared/types'
import { toMajor, toSignedMinor } from '../../shared/money'
const props = defineProps<{ account?: Account | null }>()
const emit = defineEmits<{ saved: [] }>()
const { command, pending } = useWorkspace()
const form = reactive({
  name: '',
  kind: 'card',
  openingBalance: '0',
  color: 'green',
  bankName: '',
  last4: '',
})
const error = ref('')
watch(
  () => props.account,
  (account) => {
    Object.assign(
      form,
      account
        ? { ...account, openingBalance: toMajor(account.openingBalance) }
        : { name: '', kind: 'card', openingBalance: '0', color: 'green', bankName: '', last4: '' },
    )
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
      last4: form.kind === 'card' ? form.last4 : '',
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
