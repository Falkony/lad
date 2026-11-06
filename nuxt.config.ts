export default defineNuxtConfig({
  compatibilityDate: '2026-11-05',
  modules: ['@nuxt/ui'],
  ui: { fonts: false },
  nitro: { esbuild: { options: { target: 'es2022' } } },
  vite: { build: { target: 'es2022' } },
  css: ['~/assets/css/main.css', '~/assets/css/iteration-two.css', '~/assets/css/planning.css'],
  ssr: false,
  devtools: { enabled: false },
  // The recurring payments page became the unified plans page in iteration 4a.
  routeRules: { '/recurring': { redirect: '/plans' } },
  app: {
    head: {
      title: 'Лад — деньги и дела',
      htmlAttrs: { lang: 'ru' },
      meta: [{ name: 'description', content: 'Личный центр финансов, целей и повседневных дел.' }],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
})
