// Start recording from the current revision. Past commands cannot be reconstructed reliably.
export const commandHistoryMigration = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 10) THEN
    CREATE TABLE command_history (
      id text PRIMARY KEY,
      revision numeric(20,0) NOT NULL UNIQUE CHECK (revision > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      operation text NOT NULL,
      payload jsonb NOT NULL,
      result jsonb NOT NULL
    );
    INSERT INTO lad_migrations (version) VALUES (10);
  END IF;
END $$;
`
