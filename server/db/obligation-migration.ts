// Iteration 5: repayment of obligations. The stored balance becomes the opening balance on the
// start date of accounting; the current balance follows from the history of repayments and
// reconciliations. The payment schedule of every obligation is a plan of the unified model
// (source `obligation`), so its dates reach the calendar and the forecast once.
// Complete and immutable once released: add later changes as a new version.
export const obligationMigration = `
DO $$
DECLARE
  o record;
  plan_id text;
  rem numeric;
  interest numeric;
  months integer;
  first_date date;
  start_month date;
  end_date text;
  category text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lad_migrations WHERE version = 9) THEN
    ALTER TABLE obligations RENAME COLUMN remaining TO opening_balance;
    ALTER TABLE obligations ADD COLUMN start_date text;
    UPDATE obligations SET start_date = to_char(current_date, 'YYYY-MM-DD');
    ALTER TABLE obligations ALTER COLUMN start_date SET NOT NULL;
    ALTER TABLE obligations ADD COLUMN account_id text REFERENCES accounts(id);
    CREATE TABLE obligation_entries (
      id text PRIMARY KEY,
      obligation_id text NOT NULL REFERENCES obligations(id),
      kind text NOT NULL CHECK (kind IN ('payment','adjustment')),
      date text NOT NULL,
      principal numeric(16,0) NOT NULL,
      interest numeric(16,0) NOT NULL DEFAULT 0 CHECK (interest >= 0),
      fees numeric(16,0) NOT NULL DEFAULT 0 CHECK (fees >= 0),
      transaction_id text UNIQUE REFERENCES transactions(id),
      early text NOT NULL DEFAULT 'none' CHECK (early IN ('none','term','payment')),
      previous_payment numeric(16,0),
      note text NOT NULL DEFAULT '',
      created_at timestamp NOT NULL DEFAULT now(),
      CHECK ((kind = 'payment' AND principal >= 0 AND transaction_id IS NOT NULL AND principal + interest + fees > 0)
        OR (kind = 'adjustment' AND principal <> 0 AND interest = 0 AND fees = 0 AND transaction_id IS NULL))
    );
    CREATE INDEX obligation_entries_obligation ON obligation_entries(obligation_id);
    -- A plan for every obligation with a monthly payment, ending in the month of the estimated
    -- payoff (the same estimate as shared/obligations.ts: monthly interest at rate / 12).
    FOR o IN SELECT * FROM obligations WHERE payment > 0 AND opening_balance > 0 LOOP
      rem := o.opening_balance;
      months := 0;
      WHILE rem > 0 AND months < 600 LOOP
        interest := round(rem * o.rate::numeric / 1200);
        IF o.payment <= interest THEN months := NULL; EXIT; END IF;
        rem := rem - least(o.payment - interest, rem);
        months := months + 1;
      END LOOP;
      start_month := date_trunc('month', current_date)::date;
      first_date := start_month + (least(o.due_day, extract(day FROM start_month + interval '1 month - 1 day')::integer) - 1);
      IF first_date < current_date THEN start_month := (start_month + interval '1 month')::date; END IF;
      end_date := CASE WHEN months IS NULL OR rem > 0 THEN NULL
        ELSE to_char(start_month + make_interval(months => months) - interval '1 day', 'YYYY-MM-DD') END;
      category := CASE WHEN o.kind = 'receivable' THEN 'Возврат долга' ELSE 'Кредиты и долги' END;
      plan_id := gen_random_uuid()::text;
      INSERT INTO plans (id, title, category, amount, account_id, frequency, interval, start_date, end_date, note, month_days, holiday_shift, active, direction, source, source_id)
        VALUES (plan_id, o.title, category, o.payment, NULL, 'monthly', 1, o.start_date, end_date, '', ARRAY[o.due_day], 'none', true,
          CASE WHEN o.kind = 'receivable' THEN 'income' ELSE 'expense' END, 'obligation', o.id);
      INSERT INTO plan_versions (id, plan_id, title, category, amount, account_id, frequency, interval, start_date, end_date, note, month_days, holiday_shift, valid_from, valid_to)
        VALUES (gen_random_uuid()::text, plan_id, o.title, category, o.payment, NULL, 'monthly', 1, o.start_date, end_date, '', ARRAY[o.due_day], 'none', o.start_date, NULL);
    END LOOP;
    INSERT INTO lad_migrations (version) VALUES (9);
  END IF;
END $$;
`
