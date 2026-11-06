import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL || 'postgres://lad:lad@localhost:5432/lad' },
})
