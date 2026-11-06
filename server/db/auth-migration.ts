export const authMigration = `
DO $migration$ DECLARE table_name text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM lad_migrations WHERE version=16) THEN
  CREATE TABLE auth_users(id text PRIMARY KEY,username text NOT NULL UNIQUE,password_hash text NOT NULL,created_at text NOT NULL);
  CREATE TABLE auth_workspaces(id text PRIMARY KEY,name text NOT NULL,owner_id text REFERENCES auth_users(id),singleton boolean NOT NULL DEFAULT true UNIQUE CHECK(singleton));
  INSERT INTO auth_workspaces(id,name) VALUES(gen_random_uuid()::text,'Личное пространство');
  CREATE TABLE auth_memberships(id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth_users(id),workspace_id text NOT NULL REFERENCES auth_workspaces(id),role text NOT NULL CHECK(role IN ('owner','editor','viewer')),UNIQUE(user_id,workspace_id));
  CREATE TABLE auth_sessions(id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth_users(id),workspace_id text NOT NULL REFERENCES auth_workspaces(id),token_hash text NOT NULL UNIQUE,device_name text NOT NULL,created_at text NOT NULL,expires_at text NOT NULL);
  CREATE TABLE auth_login_attempts(key text PRIMARY KEY,count integer NOT NULL,started_at text NOT NULL);
  EXECUTE 'CREATE FUNCTION lad_workspace_id() RETURNS text LANGUAGE sql STABLE AS ''SELECT id FROM auth_workspaces LIMIT 1''';
  FOREACH table_name IN ARRAY ARRAY['accounts','transactions','categories','goals','events','shopping','obligations','obligation_entries','settings','workspace_guard','command_history','budgets','plans','plan_versions','plan_occurrences','import_rules','import_templates','import_batches','import_keys','budget_history','reconciliations','period_closures'] LOOP
   EXECUTE format('ALTER TABLE %I ADD COLUMN workspace_id text NOT NULL DEFAULT lad_workspace_id() REFERENCES auth_workspaces(id)',table_name);
   EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(workspace_id=lad_workspace_id())',table_name,table_name||'_workspace_scope');
  END LOOP;
  ALTER TABLE command_history ADD COLUMN actor_user_id text;
  ALTER TABLE command_history ADD COLUMN actor_name text;
  INSERT INTO lad_migrations(version)VALUES(16);
 END IF;
END $migration$;
`
