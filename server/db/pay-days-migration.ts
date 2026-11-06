// Several days a month in one plan (salary on the 5th and the 20th) and moving a date off weekends
// and holidays to the previous working day (Labour Code, art. 136).
// Complete and immutable once released: add later changes as a new version.
export const payDaysMigration = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 8) THEN
    ALTER TABLE plans ADD COLUMN month_days integer[] NOT NULL DEFAULT '{}';
    ALTER TABLE plans ADD COLUMN holiday_shift text NOT NULL DEFAULT 'none' CHECK (holiday_shift IN ('none','before'));
    ALTER TABLE plan_versions ADD COLUMN month_days integer[] NOT NULL DEFAULT '{}';
    ALTER TABLE plan_versions ADD COLUMN holiday_shift text NOT NULL DEFAULT 'none' CHECK (holiday_shift IN ('none','before'));
    INSERT INTO lad_migrations (version) VALUES (8);
  END IF;
END $$;
`
