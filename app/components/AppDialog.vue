<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
const open = defineModel<boolean>({ default: false })
</script>
<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :ui="{
      content: 'lad-dialog',
      header: 'lad-dialog-header',
      body: 'lad-dialog-body',
      title: 'lad-dialog-title',
      description: 'lad-dialog-description',
    }"
  >
    <template #body><slot /></template>
  </UModal>
</template>
