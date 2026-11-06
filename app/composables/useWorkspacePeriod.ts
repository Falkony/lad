export function useWorkspacePeriod(month: Ref<string> | ComputedRef<string>) {
  const { setPeriod } = useWorkspace()
  watch(
    month,
    (value) => {
      if (/^\d{4}-\d{2}$/.test(value)) void setPeriod(value)
    },
    { immediate: true },
  )
}
