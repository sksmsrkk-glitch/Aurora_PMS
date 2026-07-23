-- Forward-only Korean Revised Romanization and common surname search aliases.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';

CREATE FUNCTION public.talos_search_romanize(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  result text := '';
  character text;
  codepoint integer;
  offset_value integer;
  initial_index integer;
  vowel_index integer;
  final_index integer;
  initials text[] := ARRAY[
    'g','kk','n','d','tt','r','m','b','pp','s',
    'ss','','j','jj','ch','k','t','p','h'
  ];
  vowels text[] := ARRAY[
    'a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae',
    'oe','yo','u','wo','we','wi','yu','eu','ui','i'
  ];
  finals text[] := ARRAY[
    '','k','k','k','n','n','n','t','l','k','m','l','l','l',
    'p','l','m','p','p','t','t','ng','t','t','k','t','p','h'
  ];
BEGIN
  FOREACH character IN ARRAY regexp_split_to_array(
    public.talos_search_normalize(input),''
  )
  LOOP
    codepoint := ascii(character);
    IF codepoint BETWEEN 44032 AND 55203 THEN
      offset_value := codepoint-44032;
      initial_index := (offset_value/588)+1;
      vowel_index := ((offset_value%588)/28)+1;
      final_index := (offset_value%28)+1;
      result := result
        || initials[initial_index]
        || vowels[vowel_index]
        || finals[final_index];
    ELSE
      result := result || character;
    END IF;
  END LOOP;
  RETURN public.talos_search_normalize(result);
END
$function$;

CREATE FUNCTION public.talos_search_person_aliases(
  first_name text,
  last_name text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  first_roman text := public.talos_search_romanize(first_name);
  last_roman text := public.talos_search_romanize(last_name);
  common_surname text;
BEGIN
  common_surname := CASE public.talos_search_compact(last_name)
    WHEN '김' THEN 'kim' WHEN '이' THEN 'lee' WHEN '박' THEN 'park'
    WHEN '최' THEN 'choi' WHEN '정' THEN 'jung' WHEN '강' THEN 'kang'
    WHEN '조' THEN 'cho' WHEN '윤' THEN 'yoon' WHEN '장' THEN 'jang'
    WHEN '임' THEN 'lim' WHEN '한' THEN 'han' WHEN '오' THEN 'oh'
    WHEN '서' THEN 'seo' WHEN '신' THEN 'shin' WHEN '권' THEN 'kwon'
    WHEN '황' THEN 'hwang' WHEN '안' THEN 'ahn' WHEN '송' THEN 'song'
    WHEN '전' THEN 'jeon' WHEN '홍' THEN 'hong' WHEN '유' THEN 'yoo'
    WHEN '고' THEN 'ko' WHEN '문' THEN 'moon' WHEN '양' THEN 'yang'
    WHEN '손' THEN 'son' WHEN '배' THEN 'bae' WHEN '백' THEN 'baek'
    WHEN '허' THEN 'huh' WHEN '남' THEN 'nam' WHEN '심' THEN 'shim'
    WHEN '노' THEN 'noh' WHEN '하' THEN 'ha' WHEN '곽' THEN 'kwak'
    WHEN '성' THEN 'sung' WHEN '차' THEN 'cha' WHEN '주' THEN 'joo'
    WHEN '우' THEN 'woo' WHEN '구' THEN 'koo' WHEN '민' THEN 'min'
    ELSE last_roman
  END;
  RETURN concat_ws(
    ' ',
    first_roman,
    last_roman,
    last_roman||first_roman,
    first_roman||last_roman,
    common_surname,
    common_surname||first_roman,
    first_roman||common_surname
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.talos_refresh_search_terms(
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
      SELECT public.talos_search_romanize(token)
        FROM regexp_split_to_table(document.search_text,'[[:space:]]+') token
       WHERE token ~ '[가-힣]'
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

CREATE OR REPLACE FUNCTION public.talos_refresh_reservation_search(
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
           public.talos_search_person_aliases(g.first_name,g.last_name),
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
      SELECT string_agg(
               link.external_reservation_id,
               ' ' ORDER BY link.external_reservation_id
             ) external_ids
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
    public.talos_search_compact(
      public.talos_search_korean_initials(document_text)
    ),
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

SELECT public.talos_refresh_reservation_search(property_id,id)
  FROM public.reservations;

INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,
  before_json,after_json,created_at
)
SELECT
  'migration-0034-romanized-search-'||md5(property_id),
  property_id,
  'system:migration',
  'SEARCH_ROMANIZATION_BACKFILL',
  'pms_search_documents',
  property_id,
  NULL,
  jsonb_build_object(
    'reservationDocuments',
    count(*) FILTER(WHERE entity_kind='RESERVATION')
  ),
  clock_timestamp()
FROM public.pms_search_documents
GROUP BY property_id
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607230034_korean_romanized_search_aliases')
ON CONFLICT(id) DO NOTHING;

COMMIT;
