import { categories as defaults } from '../../shared/types'
export function useCategories() {
  const { workspace } = useWorkspace()
  const categoryNames = computed(() =>
    workspace.value.categories?.length
      ? workspace.value.categories.filter((c) => !c.archived).map((c) => c.name)
      : [...defaults],
  )
  return { categoryNames }
}
