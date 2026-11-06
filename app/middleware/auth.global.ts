export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuth()
  if (!auth.loaded.value) await auth.refresh()
  if (auth.state.value.enabled && !auth.state.value.authenticated && to.path !== '/login')
    return navigateTo('/login')
  if (to.path === '/login' && auth.state.value.authenticated) return navigateTo('/')
})
