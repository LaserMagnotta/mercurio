-- Hand-written migration (ADR-010): enforces the double-entry invariant at
-- the database level, not only in application code (CLAUDE.md: "nessuna
-- logica di denaro senza test"). A DEFERRABLE CONSTRAINT TRIGGER is used
-- because a journal entry's postings are inserted as several rows within
-- the same transaction (packages/db/src/ledger.ts): the check must run once
-- at COMMIT, not after each individual row insert.

CREATE OR REPLACE FUNCTION check_journal_entry_balance() RETURNS TRIGGER AS $$
DECLARE
  entry_id uuid;
  total bigint;
BEGIN
  entry_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  SELECT COALESCE(SUM(amount_msat), 0) INTO total
  FROM postings
  WHERE journal_entry_id = entry_id;

  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger invariant violated: journal_entry % postings sum to % (must be 0)',
      entry_id, total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER postings_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_entry_balance();

-- The ledger is append-only (ADR-010): corrections are reversing entries,
-- never UPDATEs or DELETEs on existing postings/journal_entries.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER custody_events_append_only
  BEFORE UPDATE OR DELETE ON custody_events
  FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation();

-- Reviews are 1..5 stars (ARCHITECTURE.md sec.4).
ALTER TABLE reviews ADD CONSTRAINT reviews_stars_range CHECK (stars BETWEEN 1 AND 5);

-- Amounts are never negative except signed ledger postings (which can be
-- negative by design) and rate_min (also signed is fine); everything else
-- money-shaped in the domain tables must be >= 0.
ALTER TABLE shipments ADD CONSTRAINT shipments_offer_nonneg CHECK (offer_msat >= 0);
ALTER TABLE shipments ADD CONSTRAINT shipments_bond_nonneg CHECK (custody_bond_msat >= 0);
ALTER TABLE legs ADD CONSTRAINT legs_gross_nonneg CHECK (gross_msat >= 0);
ALTER TABLE legs ADD CONSTRAINT legs_net_nonneg CHECK (net_msat >= 0);
ALTER TABLE conditional_payments ADD CONSTRAINT conditional_payments_amount_positive CHECK (amount_msat > 0);
