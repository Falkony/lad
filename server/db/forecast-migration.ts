// Iteration 4b: accounts choose whether they take part in the money forecast.
// Savings stay outside by default so that a reserve is not counted as money to spend.
// Complete and immutable once released: add later changes as a new version.
export const forecastMigration = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 7) THEN
    ALTER TABLE accounts ADD COLUMN in_forecast boolean NOT NULL DEFAULT true;
    UPDATE accounts SET in_forecast = false WHERE kind = 'savings';
    INSERT INTO lad_migrations (version) VALUES (7);
  END IF;
END $$;
`
