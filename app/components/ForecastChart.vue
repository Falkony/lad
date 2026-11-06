<script setup lang="ts">
import type { ForecastDay } from '../../shared/forecast'
import { money } from '../../shared/money'
const props = defineProps<{ days: ForecastDay[]; start: string }>()
const width = 640,
  height = 170,
  pad = 8
const chart = computed(() => {
  const values = [Number(props.start), ...props.days.map((d) => Number(d.total))]
  const low = Math.min(0, ...values),
    high = Math.max(1, ...values)
  const span = high - low || 1
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - low) / span)
  const x = (i: number) => (width * i) / Math.max(1, props.days.length - 1)
  const points = props.days.map((d, i) => [x(i), y(Number(d.total))] as const)
  let minIndex = 0
  props.days.forEach((d, i) => {
    if (Number(d.total) < Number(props.days[minIndex]!.total)) minIndex = i
  })
  return {
    line: points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' '),
    area: `0,${y(low).toFixed(1)} ${points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')} ${width},${y(low).toFixed(1)}`,
    zero: y(0),
    negative: low < 0,
    min: { x: points[minIndex]![0], y: points[minIndex]![1], day: props.days[minIndex]! },
    events: props.days
      .map((d, i) => ({ d, x: x(i) }))
      .filter(({ d }) => d.events.length)
      .map(({ d, x: px }) => ({
        x: px,
        income: d.events.some((e) => e.direction === 'income'),
        title: d.events.map((e) => e.title).join(', '),
        date: d.date,
      })),
  }
})
const short = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
</script>
<template>
  <figure class="forecast-chart">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="`Прогноз остатка: минимум ${money(chart.min.day.total)} ${short(chart.min.day.date)}`"
    >
      <polygon :points="chart.area" class="forecast-area" />
      <line
        v-if="chart.negative"
        x1="0"
        :x2="width"
        :y1="chart.zero"
        :y2="chart.zero"
        class="forecast-zero"
      />
      <line
        v-for="event in chart.events"
        :key="event.date"
        :x1="event.x"
        :x2="event.x"
        :y1="height - 2"
        :y2="height - 9"
        :class="event.income ? 'forecast-tick income' : 'forecast-tick'"
      >
        <title>{{ short(event.date) }}: {{ event.title }}</title>
      </line>
      <polyline :points="chart.line" class="forecast-line" />
      <circle
        :cx="chart.min.x"
        :cy="chart.min.y"
        r="4"
        :class="Number(chart.min.day.total) < 0 ? 'forecast-min negative' : 'forecast-min'"
      />
    </svg>
    <figcaption>
      <span>{{ short(days[0]!.date) }}</span>
      <span :class="{ 'danger-text': Number(chart.min.day.total) < 0 }"
        >Минимум {{ money(chart.min.day.total) }} · {{ short(chart.min.day.date) }}</span
      >
      <span>{{ short(days.at(-1)!.date) }}</span>
    </figcaption>
  </figure>
</template>
