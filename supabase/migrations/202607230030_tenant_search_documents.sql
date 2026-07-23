-- Tenant-scoped, trigger-maintained search documents for low-latency fuzzy PMS lookup.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
DO $extension_schema$
DECLARE
  installed_schema text;
BEGIN
  SELECT namespace.nspname
    INTO installed_schema
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
   WHERE extension.extname='pg_trgm';
  IF installed_schema IS DISTINCT FROM 'extensions' THEN
    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  END IF;
END
$extension_schema$;
GRANT USAGE ON SCHEMA extensions TO aurora_app;

CREATE FUNCTION public.talos_search_normalize(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT trim(regexp_replace(lower(normalize(coalesce(input,''),NFKC)), '[[:space:]]+', ' ', 'g'))
$function$;

CREATE FUNCTION public.talos_search_compact(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT regexp_replace(public.talos_search_normalize(input), '[[:space:][:punct:]]+', '', 'g')
$function$;

CREATE FUNCTION public.talos_search_korean_initials(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  result text := '';
  character text;
  codepoint integer;
  initials text[] := ARRAY[
    'ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ',
    'ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'
  ];
BEGIN
  FOREACH character IN ARRAY regexp_split_to_array(public.talos_search_normalize(input),'')
  LOOP
    codepoint := ascii(character);
    IF codepoint BETWEEN 44032 AND 55203 THEN
      result := result || initials[((codepoint-44032)/588)+1];
    ELSE
      result := result || character;
    END IF;
  END LOOP;
  RETURN result;
END
$function$;

CREATE TABLE public.pms_search_documents (
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  search_text text NOT NULL,
  compact_text text NOT NULL,
  initial_text text NOT NULL,
  sort_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pms_search_document_kind_check
    CHECK(entity_kind IN ('RESERVATION','ROOM','AR')),
  CONSTRAINT pms_search_document_text_check
    CHECK(
      char_length(search_text) BETWEEN 1 AND 4000
      AND char_length(compact_text) BETWEEN 1 AND 4000
      AND char_length(initial_text) BETWEEN 1 AND 4000
    ),
  CONSTRAINT pms_search_document_pk PRIMARY KEY(property_id,entity_kind,entity_id)
);

CREATE INDEX pms_search_document_text_trgm_idx
  ON public.pms_search_documents
  USING gin(search_text extensions.gin_trgm_ops);
CREATE INDEX pms_search_document_compact_trgm_idx
  ON public.pms_search_documents
  USING gin(compact_text extensions.gin_trgm_ops);
CREATE INDEX pms_search_document_initial_trgm_idx
  ON public.pms_search_documents
  USING gin(initial_text extensions.gin_trgm_ops);
CREATE INDEX pms_search_document_tenant_sort_idx
  ON public.pms_search_documents(property_id,entity_kind,sort_at DESC,entity_id);

CREATE TABLE public.pms_search_terms (
  property_id text NOT NULL,
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  term text NOT NULL,
  CONSTRAINT pms_search_term_document_fk
    FOREIGN KEY(property_id,entity_kind,entity_id)
    REFERENCES public.pms_search_documents(property_id,entity_kind,entity_id)
    ON DELETE CASCADE,
  CONSTRAINT pms_search_term_length_check
    CHECK(char_length(term) BETWEEN 2 AND 120),
  CONSTRAINT pms_search_term_pk
    PRIMARY KEY(property_id,entity_kind,entity_id,term)
);
CREATE INDEX pms_search_term_trgm_idx
  ON public.pms_search_terms
  USING gin(term extensions.gin_trgm_ops);
CREATE INDEX pms_search_term_tenant_entity_idx
  ON public.pms_search_terms(property_id,entity_kind,entity_id);

ALTER TABLE public.pms_search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pms_search_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.pms_search_documents
  FOR ALL TO aurora_app
  USING(property_id=public.pms_current_property_id())
  WITH CHECK(property_id=public.pms_current_property_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.pms_search_documents TO aurora_app;
REVOKE ALL ON TABLE public.pms_search_documents FROM anon,authenticated;

ALTER TABLE public.pms_search_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pms_search_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.pms_search_terms
  FOR ALL TO aurora_app
  USING(property_id=public.pms_current_property_id())
  WITH CHECK(property_id=public.pms_current_property_id());
GRANT SELECT,INSERT,DELETE ON TABLE public.pms_search_terms TO aurora_app;
REVOKE ALL ON TABLE public.pms_search_terms FROM anon,authenticated;

CREATE FUNCTION public.talos_refresh_search_terms(
  target_property_id text,
  target_entity_kind text,
  target_entity_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM public.pms_search_terms
   WHERE property_id=target_property_id
     AND entity_kind=target_entity_kind
     AND entity_id=target_entity_id;

  INSERT INTO public.pms_search_terms(property_id,entity_kind,entity_id,term)
  SELECT DISTINCT
         document.property_id,
         document.entity_kind,
         document.entity_id,
         candidate.term
    FROM public.pms_search_documents document
    CROSS JOIN LATERAL (
      SELECT token term
        FROM regexp_split_to_table(document.search_text,'[[:space:]]+') token
      UNION
      SELECT document.compact_text
      UNION
      SELECT document.initial_text
    ) candidate
   WHERE document.property_id=target_property_id
     AND document.entity_kind=target_entity_kind
     AND document.entity_id=target_entity_id
     AND char_length(candidate.term) BETWEEN 2 AND 120
  ON CONFLICT DO NOTHING;
END
$function$;

CREATE FUNCTION public.talos_refresh_reservation_search(
  target_property_id text,
  target_reservation_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  document_text text;
  document_sort_at timestamptz;
BEGIN
  SELECT concat_ws(
           ' ',
           r.confirmation_no,
           g.first_name,
           g.last_name,
           g.last_name||g.first_name,
           g.phone,
           g.email,
           rm.number,
           rt.code,
           rt.name,
           r.source,
           r.rate_plan,
           external_links.external_ids
         ),
         r.updated_at
    INTO document_text,document_sort_at
    FROM public.reservations r
    JOIN public.guests g
      ON g.property_id=r.property_id AND g.id=r.guest_id
    JOIN public.room_types rt
      ON rt.property_id=r.property_id AND rt.id=r.room_type_id
    LEFT JOIN public.rooms rm
      ON rm.property_id=r.property_id AND rm.id=r.room_id
    LEFT JOIN LATERAL (
      SELECT string_agg(link.external_reservation_id,' ' ORDER BY link.external_reservation_id) external_ids
        FROM public.channel_reservation_links link
       WHERE link.property_id=r.property_id
         AND link.reservation_id=r.id
    ) external_links ON true
   WHERE r.property_id=target_property_id
     AND r.id=target_reservation_id;

  IF document_text IS NULL THEN
    DELETE FROM public.pms_search_documents
     WHERE property_id=target_property_id
       AND entity_kind='RESERVATION'
       AND entity_id=target_reservation_id;
    RETURN;
  END IF;

  INSERT INTO public.pms_search_documents(
    property_id,entity_kind,entity_id,search_text,compact_text,initial_text,
    sort_at,indexed_at
  )
  VALUES(
    target_property_id,'RESERVATION',target_reservation_id,
    public.talos_search_normalize(document_text),
    public.talos_search_compact(document_text),
    public.talos_search_compact(public.talos_search_korean_initials(document_text)),
    document_sort_at,clock_timestamp()
  )
  ON CONFLICT(property_id,entity_kind,entity_id)
  DO UPDATE SET
    search_text=excluded.search_text,
    compact_text=excluded.compact_text,
    initial_text=excluded.initial_text,
    sort_at=excluded.sort_at,
    indexed_at=excluded.indexed_at;
  PERFORM public.talos_refresh_search_terms(
    target_property_id,'RESERVATION',target_reservation_id
  );
END
$function$;

CREATE FUNCTION public.talos_refresh_room_search(
  target_property_id text,
  target_room_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  document_text text;
  document_sort_at timestamptz;
BEGIN
  SELECT concat_ws(
           ' ',rm.number,rt.code,rt.name,rm.floor,
           rm.front_desk_status,rm.housekeeping_status,rm.features
         ),
         clock_timestamp()
    INTO document_text,document_sort_at
    FROM public.rooms rm
    JOIN public.room_types rt
      ON rt.property_id=rm.property_id AND rt.id=rm.room_type_id
   WHERE rm.property_id=target_property_id
     AND rm.id=target_room_id
     AND rm.active;

  IF document_text IS NULL THEN
    DELETE FROM public.pms_search_documents
     WHERE property_id=target_property_id
       AND entity_kind='ROOM'
       AND entity_id=target_room_id;
    RETURN;
  END IF;

  INSERT INTO public.pms_search_documents(
    property_id,entity_kind,entity_id,search_text,compact_text,initial_text,
    sort_at,indexed_at
  )
  VALUES(
    target_property_id,'ROOM',target_room_id,
    public.talos_search_normalize(document_text),
    public.talos_search_compact(document_text),
    public.talos_search_compact(public.talos_search_korean_initials(document_text)),
    document_sort_at,clock_timestamp()
  )
  ON CONFLICT(property_id,entity_kind,entity_id)
  DO UPDATE SET
    search_text=excluded.search_text,
    compact_text=excluded.compact_text,
    initial_text=excluded.initial_text,
    sort_at=excluded.sort_at,
    indexed_at=excluded.indexed_at;
  PERFORM public.talos_refresh_search_terms(
    target_property_id,'ROOM',target_room_id
  );
END
$function$;

CREATE FUNCTION public.talos_refresh_ar_search(
  target_property_id text,
  target_invoice_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  document_text text;
  document_sort_at timestamptz;
BEGIN
  SELECT concat_ws(' ',i.invoice_no,a.account_no,a.name,i.status,i.due_date),
         i.created_at
    INTO document_text,document_sort_at
    FROM public.ar_invoices i
    JOIN public.ar_accounts a
      ON a.property_id=i.property_id AND a.id=i.ar_account_id
   WHERE i.property_id=target_property_id
     AND i.id=target_invoice_id;

  IF document_text IS NULL THEN
    DELETE FROM public.pms_search_documents
     WHERE property_id=target_property_id
       AND entity_kind='AR'
       AND entity_id=target_invoice_id;
    RETURN;
  END IF;

  INSERT INTO public.pms_search_documents(
    property_id,entity_kind,entity_id,search_text,compact_text,initial_text,
    sort_at,indexed_at
  )
  VALUES(
    target_property_id,'AR',target_invoice_id,
    public.talos_search_normalize(document_text),
    public.talos_search_compact(document_text),
    public.talos_search_compact(public.talos_search_korean_initials(document_text)),
    document_sort_at,clock_timestamp()
  )
  ON CONFLICT(property_id,entity_kind,entity_id)
  DO UPDATE SET
    search_text=excluded.search_text,
    compact_text=excluded.compact_text,
    initial_text=excluded.initial_text,
    sort_at=excluded.sort_at,
    indexed_at=excluded.indexed_at;
  PERFORM public.talos_refresh_search_terms(
    target_property_id,'AR',target_invoice_id
  );
END
$function$;

CREATE FUNCTION public.talos_reservation_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM public.pms_search_documents
     WHERE property_id=OLD.property_id
       AND entity_kind='RESERVATION'
       AND entity_id=OLD.id;
    RETURN OLD;
  END IF;
  PERFORM public.talos_refresh_reservation_search(NEW.property_id,NEW.id);
  RETURN NEW;
END
$function$;
CREATE TRIGGER reservation_search_document_sync
AFTER INSERT OR UPDATE OR DELETE ON public.reservations
FOR EACH ROW EXECUTE FUNCTION public.talos_reservation_search_trigger();

CREATE FUNCTION public.talos_guest_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  reservation_row record;
BEGIN
  FOR reservation_row IN
    SELECT id
      FROM public.reservations
     WHERE property_id=NEW.property_id
       AND guest_id=NEW.id
  LOOP
    PERFORM public.talos_refresh_reservation_search(NEW.property_id,reservation_row.id);
  END LOOP;
  RETURN NEW;
END
$function$;
CREATE TRIGGER guest_search_document_sync
AFTER UPDATE OF first_name,last_name,email,phone ON public.guests
FOR EACH ROW EXECUTE FUNCTION public.talos_guest_search_trigger();

CREATE FUNCTION public.talos_room_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  reservation_row record;
  property_value text;
  room_value text;
BEGIN
  IF TG_OP='DELETE' THEN
    property_value := OLD.property_id;
    room_value := OLD.id;
    DELETE FROM public.pms_search_documents
     WHERE property_id=OLD.property_id
       AND entity_kind='ROOM'
       AND entity_id=OLD.id;
  ELSE
    property_value := NEW.property_id;
    room_value := NEW.id;
    PERFORM public.talos_refresh_room_search(NEW.property_id,NEW.id);
  END IF;
  FOR reservation_row IN
    SELECT id
      FROM public.reservations
     WHERE property_id=property_value
       AND room_id=room_value
  LOOP
    PERFORM public.talos_refresh_reservation_search(property_value,reservation_row.id);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER room_search_document_sync
AFTER INSERT OR UPDATE OR DELETE ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.talos_room_search_trigger();

CREATE FUNCTION public.talos_room_type_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  room_row record;
  reservation_row record;
BEGIN
  FOR room_row IN
    SELECT id
      FROM public.rooms
     WHERE property_id=NEW.property_id
       AND room_type_id=NEW.id
  LOOP
    PERFORM public.talos_refresh_room_search(NEW.property_id,room_row.id);
  END LOOP;
  FOR reservation_row IN
    SELECT id
      FROM public.reservations
     WHERE property_id=NEW.property_id
       AND room_type_id=NEW.id
  LOOP
    PERFORM public.talos_refresh_reservation_search(NEW.property_id,reservation_row.id);
  END LOOP;
  RETURN NEW;
END
$function$;
CREATE TRIGGER room_type_search_document_sync
AFTER UPDATE OF code,name ON public.room_types
FOR EACH ROW EXECUTE FUNCTION public.talos_room_type_search_trigger();

CREATE FUNCTION public.talos_channel_link_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.talos_refresh_reservation_search(OLD.property_id,OLD.reservation_id);
    RETURN OLD;
  END IF;
  PERFORM public.talos_refresh_reservation_search(NEW.property_id,NEW.reservation_id);
  RETURN NEW;
END
$function$;
CREATE TRIGGER channel_link_search_document_sync
AFTER INSERT OR UPDATE OF external_reservation_id,reservation_id OR DELETE
ON public.channel_reservation_links
FOR EACH ROW EXECUTE FUNCTION public.talos_channel_link_search_trigger();

CREATE FUNCTION public.talos_ar_invoice_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM public.pms_search_documents
     WHERE property_id=OLD.property_id
       AND entity_kind='AR'
       AND entity_id=OLD.id;
    RETURN OLD;
  END IF;
  PERFORM public.talos_refresh_ar_search(NEW.property_id,NEW.id);
  RETURN NEW;
END
$function$;
CREATE TRIGGER ar_invoice_search_document_sync
AFTER INSERT OR UPDATE OR DELETE ON public.ar_invoices
FOR EACH ROW EXECUTE FUNCTION public.talos_ar_invoice_search_trigger();

CREATE FUNCTION public.talos_ar_account_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  invoice_row record;
BEGIN
  FOR invoice_row IN
    SELECT id
      FROM public.ar_invoices
     WHERE property_id=NEW.property_id
       AND ar_account_id=NEW.id
  LOOP
    PERFORM public.talos_refresh_ar_search(NEW.property_id,invoice_row.id);
  END LOOP;
  RETURN NEW;
END
$function$;
CREATE TRIGGER ar_account_search_document_sync
AFTER UPDATE OF account_no,name ON public.ar_accounts
FOR EACH ROW EXECUTE FUNCTION public.talos_ar_account_search_trigger();

SELECT public.talos_refresh_reservation_search(property_id,id)
  FROM public.reservations;
SELECT public.talos_refresh_room_search(property_id,id)
  FROM public.rooms;
SELECT public.talos_refresh_ar_search(property_id,id)
  FROM public.ar_invoices;

INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,
  before_json,after_json,created_at
)
SELECT
  'migration-0030-search-'||md5(property_id),
  property_id,
  'system:migration',
  'SEARCH_INDEX_BACKFILL',
  'pms_search_documents',
  property_id,
  NULL,
  jsonb_build_object(
    'reservationDocuments',count(*) FILTER(WHERE entity_kind='RESERVATION'),
    'roomDocuments',count(*) FILTER(WHERE entity_kind='ROOM'),
    'arDocuments',count(*) FILTER(WHERE entity_kind='AR')
  ),
  clock_timestamp()
FROM public.pms_search_documents
GROUP BY property_id
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607230030_tenant_search_documents')
ON CONFLICT(id) DO NOTHING;

COMMIT;
