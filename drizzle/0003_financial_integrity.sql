CREATE TRIGGER `folio_entries_validate_insert`
BEFORE INSERT ON `folio_entries`
WHEN NEW.`amount` <= 0 OR NEW.`kind` NOT IN ('CHARGE', 'PAYMENT')
BEGIN
  SELECT RAISE(ABORT, 'invalid folio entry');
END;
--> statement-breakpoint
CREATE TRIGGER `folio_entries_no_update`
BEFORE UPDATE ON `folio_entries`
BEGIN
  SELECT RAISE(ABORT, 'folio entries are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `folio_entries_no_delete`
BEFORE DELETE ON `folio_entries`
BEGIN
  SELECT RAISE(ABORT, 'folio entries are immutable');
END;
