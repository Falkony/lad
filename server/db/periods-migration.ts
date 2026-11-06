export const periodsMigration = `
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM lad_migrations WHERE version=15) THEN
  CREATE TABLE budget_history(id text PRIMARY KEY,month text NOT NULL,category_id text NOT NULL,category text NOT NULL,old_limit numeric(16,0),new_limit numeric(16,0),revision numeric(20,0) NOT NULL,created_at text NOT NULL,operation text NOT NULL,UNIQUE(revision,month,category_id));
  INSERT INTO budget_history SELECT gen_random_uuid()::text,month,category_id,category,NULL,"limit",0,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'baseline' FROM budgets;
  CREATE TABLE reconciliations(id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),date text NOT NULL,balance numeric(16,0) NOT NULL,revision numeric(20,0) NOT NULL,created_at text NOT NULL);
  CREATE INDEX reconciliations_account_date ON reconciliations(account_id,date);
  INSERT INTO reconciliations SELECT gen_random_uuid()::text,a.id,h.payload->'data'->>'date',(h.payload->'data'->>'targetBalance')::numeric,h.revision,to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM command_history h JOIN accounts a ON a.id=h.payload->>'id' WHERE h.operation='account.reconcile';
  CREATE TABLE period_closures(id text PRIMARY KEY,month text NOT NULL,generation integer NOT NULL,status text NOT NULL,source_revision text NOT NULL,revision text NOT NULL,created_at text NOT NULL,reopened_at text,note text NOT NULL,reopen_note text NOT NULL,snapshot jsonb NOT NULL,sha256 text NOT NULL,UNIQUE(month,generation));
  INSERT INTO lad_migrations(version)VALUES(15);
 END IF;
END $$;
`
