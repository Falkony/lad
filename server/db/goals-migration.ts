export const goalsMigration = `
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM lad_migrations WHERE version=13) THEN
  ALTER TABLE goals ADD COLUMN mandatory boolean NOT NULL DEFAULT false;
  ALTER TABLE goals ADD COLUMN category_id text REFERENCES categories(id);
  ALTER TABLE goals ADD COLUMN purchase_month text;
  ALTER TABLE goals ADD COLUMN monthly_contribution numeric(16,0) NOT NULL DEFAULT 0;
  ALTER TABLE goals ADD COLUMN funding jsonb NOT NULL DEFAULT '{"unassigned":"0","entries":[],"purchases":[]}';
  UPDATE goals SET funding=jsonb_build_object('unassigned',saved::text,'entries','[]'::jsonb,'purchases','[]'::jsonb);
  INSERT INTO lad_migrations(version)VALUES(13);
 END IF;
END $$;
`
