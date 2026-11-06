export const importQualityMigration = `
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM lad_migrations WHERE version=14) THEN
  ALTER TABLE transactions ADD COLUMN splits jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE transactions ADD COLUMN refund_of text REFERENCES transactions(id);
  CREATE INDEX transactions_page ON transactions(date DESC,created_at DESC,id DESC);
  CREATE INDEX transactions_account_date ON transactions(account_id,date);
  CREATE INDEX transactions_target_date ON transactions(to_account_id,date);
  CREATE INDEX transactions_refund ON transactions(refund_of);
  CREATE TABLE import_rules(id text PRIMARY KEY,name text NOT NULL,pattern text NOT NULL,account_id text REFERENCES accounts(id),kind text,category_id text NOT NULL REFERENCES categories(id),priority integer NOT NULL DEFAULT 100,enabled boolean NOT NULL DEFAULT true);
  CREATE TABLE import_templates(id text PRIMARY KEY,name text NOT NULL UNIQUE,mapping jsonb NOT NULL);
  CREATE TABLE import_batches(id text PRIMARY KEY,created_at text NOT NULL,file_name text NOT NULL,status text NOT NULL,revision text NOT NULL,report jsonb NOT NULL,records jsonb NOT NULL);
  CREATE TABLE import_keys(id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),key text NOT NULL,transaction_id text NOT NULL REFERENCES transactions(id),batch_id text REFERENCES import_batches(id),UNIQUE(account_id,key));
  INSERT INTO import_keys(id,account_id,key,transaction_id) SELECT gen_random_uuid()::text,coalesce(import_account_id,account_id),import_key,id FROM transactions WHERE import_key IS NOT NULL;
  UPDATE transactions t SET refund_of=p.value->>'transactionId' FROM goals g CROSS JOIN LATERAL jsonb_array_elements(g.funding->'purchases') p CROSS JOIN LATERAL jsonb_array_elements_text(p.value->'refundIds') r WHERE t.id=r.value;
  INSERT INTO lad_migrations(version)VALUES(14);
 END IF;
END $$;
`
