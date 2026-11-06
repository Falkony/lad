import { defineConfig } from 'drizzle-kit'

// The database is migrated by the hand-written SQL in server/db/migration.ts, not by drizzle-kit.
// This config is only for read-only tooling such as `npx drizzle-kit studio`.
// tests/schema-drift.test.ts keeps server/db/schema.ts in sync with that SQL.
export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL || 'postgres://lad:lad@localhost:5432/lad' },
})
