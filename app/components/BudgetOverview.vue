<script setup lang="ts">
import { budgetRows } from '../../shared/planning'
import { money } from '../../shared/money'
const props = defineProps<{ month: string }>()
const { workspace } = useWorkspace()
const rows = computed(() =>
  budgetRows(workspace.value, props.month)
    .sort((a, b) => Number(BigInt(a.remaining) >= 0n) - Number(BigInt(b.remaining) >= 0n))
    .slice(0, 3),
)
</script>
<template>
  <section class="budget-overview">
    <div class="inline-heading">
      <h2>Бюджет под рукой</h2>
      <NuxtLink :to="{ path: '/budgets', query: { month } }" class="text-button"
        >Все лимиты <AppIcon name="arrow" :size="14"
      /></NuxtLink>
    </div>
    <div v-if="rows.length" class="budget-mini-grid">
      <NuxtLink
        v-for="row in rows"
        :key="row.id"
        :to="{ path: '/budgets', query: { month } }"
        class="budget-mini"
        :class="{ over: BigInt(row.remaining) < 0n }"
        ><strong>{{ row.category }}</strong
        ><span
          >{{ money(row.spent) }} <span>из {{ money(row.limit) }}</span></span
        >
        <div class="progress-bar"><span :style="{ width: `${row.percent}%` }" /></div>
        <small>{{
          BigInt(row.remaining) < 0n
            ? `Перерасход ${money(-BigInt(row.remaining))}`
            : `Осталось ${money(row.remaining)}`
        }}</small></NuxtLink
      >
    </div>
    <NuxtLink v-else :to="{ path: '/budgets', query: { month } }" class="empty-budget-link"
      ><AppIcon name="budget" :size="22" /><span
        >Задайте лимиты на месяц и следите за расходами по категориям.</span
      ><AppIcon name="arrow" :size="17"
    /></NuxtLink>
  </section>
</template>
