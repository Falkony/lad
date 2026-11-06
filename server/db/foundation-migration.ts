export const foundationMigration = `
DO $$ DECLARE tab text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM lad_migrations WHERE version=11) THEN
  CREATE TABLE categories(id text PRIMARY KEY, name text NOT NULL UNIQUE, archived boolean NOT NULL DEFAULT false);
  INSERT INTO categories(id,name) SELECT gen_random_uuid()::text, name FROM (
   SELECT category AS name FROM transactions UNION SELECT category FROM budgets
   UNION SELECT category FROM plans UNION SELECT category FROM plan_versions UNION SELECT category FROM plan_occurrences
   UNION SELECT unnest(ARRAY['Продукты','Дом','Транспорт','Здоровье','Развлечения','Покупки','Кафе','Подписки','Зарплата','Другое'])
  ) names;
  FOREACH tab IN ARRAY ARRAY['transactions','budgets','plans','plan_versions','plan_occurrences'] LOOP
   EXECUTE format('ALTER TABLE %I ADD COLUMN category_id text DEFAULT NULL REFERENCES categories(id)',tab);
   EXECUTE format('UPDATE %I t SET category_id=c.id FROM categories c WHERE c.name=t.category',tab);
   EXECUTE format('ALTER TABLE %I ALTER COLUMN category_id SET NOT NULL',tab);
  END LOOP;
  INSERT INTO settings(key,value) VALUES('time_zone','Europe/Moscow') ON CONFLICT DO NOTHING;
  INSERT INTO lad_migrations(version) VALUES(11);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION resolve_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resolved text; BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.category IS DISTINCT FROM OLD.category AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id THEN
   NEW.category_id := NULL;
  END IF;
 END IF;
 IF NEW.category_id IS NULL THEN
  INSERT INTO categories(id,name) VALUES(gen_random_uuid()::text,NEW.category) ON CONFLICT(name) DO NOTHING;
  SELECT id INTO NEW.category_id FROM categories WHERE name=NEW.category;
 ELSE
  SELECT name INTO resolved FROM categories WHERE id=NEW.category_id;
  IF resolved IS NULL THEN RAISE EXCEPTION 'Unknown category' USING ERRCODE='23503'; END IF;
  NEW.category := resolved;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['transactions','budgets','plans','plan_versions','plan_occurrences'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=tab||'_category_ref') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION resolve_category()',tab||'_category_ref',tab);
  END IF;
 END LOOP;
END $$;
`
