-- Idempotent starter property for both the historical migration checkpoint used
-- by CI and the current multi-hotel schema. Dynamic SQL prevents either column
-- shape from being parsed against the wrong schema version.
DO $seed_property$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    EXECUTE $sql$
      INSERT INTO properties(id,name,code,timezone,currency,business_date)
      VALUES ('prop-seoul','서울 샘플 호텔','SEL01','Asia/Seoul','KRW','2026-07-16')
      ON CONFLICT (id) DO NOTHING
    $sql$;
  ELSE
    EXECUTE $sql$
      INSERT INTO organizations(id,name,slug,status)
      VALUES ('org-prop-seoul','서울 샘플 호텔 운영사','sample-seoul','ACTIVE')
      ON CONFLICT(id) DO NOTHING;

      INSERT INTO properties(
        id,name,code,timezone,currency,business_date,organization_id,slug,
        status,onboarding_status,plan_code,cell_key,settings
      ) VALUES (
        'prop-seoul','서울 샘플 호텔','SEL01','Asia/Seoul','KRW','2026-07-16',
        'org-prop-seoul','sample-seoul','ACTIVE','LIVE','STANDARD','primary','{}'::jsonb
      ) ON CONFLICT(id) DO NOTHING;

      INSERT INTO property_subscriptions(
        id,property_id,plan_code,status,current_period_start,current_period_end
      ) VALUES (
        'subscription-prop-seoul','prop-seoul','STANDARD','ACTIVE',DATE '2026-07-16',DATE '2099-12-31'
      ) ON CONFLICT(property_id) DO NOTHING;

      INSERT INTO property_entitlements(property_id,feature_key,enabled,limits,updated_by)
      SELECT 'prop-seoul',feature,true,'{}'::jsonb,'system:seed'
      FROM unnest(ARRAY[
        'CORE_PMS','DIRECT_BOOKING','WEBSITE_CMS','REPORT_EXPORT','ACCOUNTING',
        'CHANNEL_HUB','GROUP_SALES','STAFF_ACCESS','DATA_IMPORT','SUPPORT_ACCESS'
      ]) feature
      ON CONFLICT(property_id,feature_key) DO NOTHING;

      INSERT INTO property_domains(id,property_id,hostname,kind,status,is_primary,verified_at)
      VALUES ('domain-prop-seoul-platform','prop-seoul','aurora-pms-gilt.vercel.app','PLATFORM','ACTIVE',true,clock_timestamp())
      ON CONFLICT(hostname) DO NOTHING
    $sql$;
  END IF;
END
$seed_property$;

INSERT INTO room_types(id,property_id,code,name,base_rate,capacity,description,active,version) VALUES
  ('rt-standard-twin','prop-seoul','STWN','Standard Twin Room',160000,2,'싱글 베드 2개를 갖춘 실용적인 스탠다드 객실','1',1),
  ('rt-dlx','prop-seoul','SDBL','Standard Double Room',170000,2,'더블 베드 1개를 갖춘 편안한 스탠다드 객실','1',1),
  ('rt-family-twin','prop-seoul','FTWN','Family Twin Room',210000,3,'더블 베드와 싱글 베드를 갖춘 가족형 객실','1',1),
  ('rt-triple','prop-seoul','TRPL','Triple Room',230000,3,'3인이 편안하게 머무를 수 있는 트리플 객실','1',1),
  ('rt-twn','prop-seoul','PTWN','Premier Twin Room',240000,2,'상층부에 위치한 프리미어 트윈 객실','1',1),
  ('rt-premier-double','prop-seoul','PDBL','Premier Double Room',250000,2,'상층부에 위치한 프리미어 더블 객실','1',1),
  ('rt-premier-family-twin','prop-seoul','PFTWN','Premier Family Twin Room',290000,3,'넓은 공간과 상층 전망을 갖춘 프리미어 가족형 객실','1',1),
  ('rt-ste','prop-seoul','SUITE','Suite Room',420000,4,'침실과 휴식 공간이 분리된 최상층 스위트 객실','1',1)
ON CONFLICT (id) DO NOTHING;

-- CI deliberately seeds a populated migration-009 database before upgrading it
-- through tenant RLS, native temporal types, and the Rate Plan domain. Dynamic
-- SQL keeps that historical seed valid while still projecting Rate Plans after
-- migration 012 on the second idempotent seed pass.
DO $seed_rate_plans$
BEGIN
  IF to_regclass('public.rate_plans') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO rate_plans(
        id,property_id,code,name,description,currency,market_segment,meal_plan,
        cancellation_policy,guarantee_policy,pricing_model,adjustment,min_stay,max_stay,
        valid_from,valid_to,active,version,created_at,updated_at,created_by,updated_by
      ) VALUES
        ('rp-prop-seoul-bar','prop-seoul','BAR','Best Available Rate','호텔 표준 유연 요금','KRW','TRANSIENT','ROOM_ONLY','FLEXIBLE','CARD_GUARANTEE','FIXED',0,1,30,NULL,NULL,'1',1,clock_timestamp(),clock_timestamp(),'system:seed','system:seed'),
        ('rp-prop-seoul-web','prop-seoul','WEB-DIRECT','공식 홈페이지 전용','공식 홈페이지 실시간 판매 요금','KRW','DIRECT','ROOM_ONLY','FLEXIBLE','CARD_GUARANTEE','FIXED',0,1,30,NULL,NULL,'1',1,clock_timestamp(),clock_timestamp(),'system:seed','system:seed'),
        ('rp-prop-seoul-ota','prop-seoul','OTA','온라인 채널 표준','OTA 채널 매핑 기본 요금','KRW','OTA','ROOM_ONLY','FLEXIBLE','CARD_GUARANTEE','FIXED',0,1,30,NULL,NULL,'1',1,clock_timestamp(),clock_timestamp(),'system:seed','system:seed'),
        ('rp-prop-seoul-corp','prop-seoul','CORP','기업체 계약 요금','기업체 협약 고객용 요금','KRW','CORPORATE','ROOM_ONLY','DAY_1','DIRECT_BILL','FIXED',0,1,30,NULL,NULL,'1',1,clock_timestamp(),clock_timestamp(),'system:seed','system:seed')
      ON CONFLICT(property_id,code) DO NOTHING;

      INSERT INTO rate_plan_room_types(property_id,rate_plan_id,room_type_id,base_rate,active,version,updated_at,updated_by)
      SELECT rp.property_id,rp.id,rt.id,rt.base_rate,'1',1,clock_timestamp(),'system:seed'
      FROM rate_plans rp
      JOIN room_types rt ON rt.property_id=rp.property_id
      WHERE rp.property_id='prop-seoul'
      ON CONFLICT(property_id,rate_plan_id,room_type_id) DO NOTHING
    $sql$;
  END IF;
END
$seed_rate_plans$;

-- The starter property models an eight-floor building with guestrooms on
-- floors 3-8. The deterministic distribution totals exactly 160 sellable rooms.
WITH room_slots AS (
  SELECT 3 floor,generate_series(1,27) sequence
  UNION ALL SELECT 4,generate_series(1,27)
  UNION ALL SELECT 5,generate_series(1,26)
  UNION ALL SELECT 6,generate_series(1,26)
  UNION ALL SELECT 7,generate_series(1,26)
  UNION ALL SELECT 8,generate_series(1,28)
), room_plan AS (
  SELECT
    floor,
    (floor*100+sequence)::text number,
    CASE
      WHEN floor IN (3,4) AND sequence<=14 THEN 'rt-standard-twin'
      WHEN floor IN (3,4) AND sequence<=24 THEN 'rt-dlx'
      WHEN floor IN (3,4) THEN 'rt-family-twin'
      WHEN floor=5 AND sequence<=8 THEN 'rt-dlx'
      WHEN floor=5 AND sequence<=16 THEN 'rt-family-twin'
      WHEN floor=5 THEN 'rt-triple'
      WHEN floor=6 AND sequence<=12 THEN 'rt-twn'
      WHEN floor=6 AND sequence<=22 THEN 'rt-premier-double'
      WHEN floor=6 THEN 'rt-triple'
      WHEN floor=7 AND sequence<=10 THEN 'rt-twn'
      WHEN floor=7 AND sequence<=22 THEN 'rt-premier-double'
      WHEN floor=7 THEN 'rt-premier-family-twin'
      WHEN floor=8 AND sequence<=4 THEN 'rt-family-twin'
      WHEN floor=8 AND sequence<=16 THEN 'rt-premier-family-twin'
      ELSE 'rt-ste'
    END room_type_id
  FROM room_slots
)
INSERT INTO rooms(
  id,property_id,room_type_id,number,floor,front_desk_status,
  housekeeping_status,features,version,active
)
SELECT
  'room-'||number,
  'prop-seoul',
  room_type_id,
  number,
  floor,
  'VACANT',
  'CLEAN',
  '["금연"]',
  1,
  '1'
FROM room_plan
ON CONFLICT(id) DO NOTHING;

INSERT INTO guests(id,property_id,first_name,last_name,email,phone,vip_level,nationality,preferences,created_at) VALUES
  ('g1','prop-seoul','민지','김','g1@example.com','010-2011-8800','GOLD','KR','["고층","조용한 객실"]',clock_timestamp()),
  ('g2','prop-seoul','Sofia','Martinez','g2@example.com','010-2012-8800','NONE','ES','[]',clock_timestamp()),
  ('g3','prop-seoul','서연','박','g3@example.com','010-2013-8800','PLATINUM','KR','["고층","조용한 객실"]',clock_timestamp()),
  ('g4','prop-seoul','David','Chen','g4@example.com','010-2014-8800','SILVER','US','["공항 픽업"]',clock_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO reservations(id,confirmation_no,property_id,guest_id,room_type_id,room_id,arrival_date,departure_date,status,adults,children,source,rate_plan,nightly_rate,eta,notes,version,created_at,updated_at) VALUES
  ('r1','SEL-260716-0184','prop-seoul','g1','rt-dlx','room-315','2026-07-16','2026-07-17','DUE_IN',2,0,'Direct','BAR',170000,'14:00','',1,clock_timestamp(),clock_timestamp()),
  ('r2','SEL-260716-0191','prop-seoul','g2','rt-family-twin','room-325','2026-07-16','2026-07-17','DUE_IN',2,1,'Booking.com','OTA',210000,'15:30','',1,clock_timestamp(),clock_timestamp()),
  ('r3','SEL-260715-0168','prop-seoul','g3','rt-dlx','room-316','2026-07-15','2026-07-18','IN_HOUSE',1,0,'Corporate','CORP',170000,NULL,'',1,clock_timestamp(),clock_timestamp()),
  ('r4','SEL-260716-0202','prop-seoul','g4','rt-ste',NULL,'2026-07-16','2026-07-17','DUE_IN',2,0,'Expedia','OTA',420000,'17:00','Late arrival · airport transfer',1,clock_timestamp(),clock_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date)
SELECT seed.property_id,seed.reservation_id,seed.room_type_id,seed.stay_date::date FROM (VALUES
  ('prop-seoul','r1','rt-dlx','2026-07-16'),
  ('prop-seoul','r2','rt-family-twin','2026-07-16'),
  ('prop-seoul','r3','rt-dlx','2026-07-15'),
  ('prop-seoul','r3','rt-dlx','2026-07-16'),
  ('prop-seoul','r3','rt-dlx','2026-07-17'),
  ('prop-seoul','r4','rt-ste','2026-07-16')
) AS seed(property_id,reservation_id,room_type_id,stay_date)
WHERE NOT EXISTS (
  SELECT 1
    FROM reservation_type_nights existing
   WHERE existing.reservation_id=seed.reservation_id
     AND existing.stay_date::text=seed.stay_date
);

INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES
  ('prop-seoul','r1','room-315','2026-07-16'),
  ('prop-seoul','r2','room-325','2026-07-16'),
  ('prop-seoul','r3','room-316','2026-07-15'),
  ('prop-seoul','r3','room-316','2026-07-16'),
  ('prop-seoul','r3','room-316','2026-07-17')
ON CONFLICT (property_id,room_id,stay_date) DO NOTHING;

INSERT INTO folio_windows(id,property_id,reservation_id,window_no,name,payee_type,payee_account_profile_id,status,created_at,created_by,closed_at) VALUES
  ('fw-r1','prop-seoul','r1',1,'Guest Folio','GUEST',NULL,'OPEN',clock_timestamp(),'system',NULL),
  ('fw-r2','prop-seoul','r2',1,'Guest Folio','GUEST',NULL,'OPEN',clock_timestamp(),'system',NULL),
  ('fw-r3','prop-seoul','r3',1,'Guest Folio','GUEST',NULL,'OPEN',clock_timestamp(),'system',NULL),
  ('fw-r4','prop-seoul','r4',1,'Guest Folio','GUEST',NULL,'OPEN',clock_timestamp(),'system',NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_codes(id,property_id,code,name,category,tax_rate,service_rate,active) VALUES
  ('tc-room','prop-seoul','ROOM','객실료','ROOM',10,0,'1'),
  ('tc-fnb','prop-seoul','FNB','식음료','FNB',10,0,'1'),
  ('tc-cash','prop-seoul','CASH','현금','PAYMENT',0,0,'1'),
  ('tc-card','prop-seoul','CARD','신용카드','PAYMENT',0,0,'1'),
  ('tc-direct-bill','prop-seoul','DIRECT_BILL','후불 이관','PAYMENT',0,0,'1')
ON CONFLICT (property_id,code) DO NOTHING;

INSERT INTO folio_entries(id,property_id,reservation_id,kind,code,description,amount,payment_method,business_date,created_at,created_by,reverses_entry_id)
VALUES ('fe1','prop-seoul','r3','CHARGE','ROOM','객실료',198000,NULL,'2026-07-15',clock_timestamp(),'night-audit',NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO folio_entry_details(entry_id,property_id,reservation_id,folio_window_id,net_amount,tax_amount,service_amount,currency,source_entry_id,reason,created_at)
VALUES ('fe1','prop-seoul','r3','fw-r3',180000,18000,0,'KRW',NULL,'숙박 객실료',clock_timestamp())
ON CONFLICT (entry_id) DO NOTHING;

INSERT INTO housekeeping_tasks(id,property_id,room_id,business_date,status,priority,assignee,notes,updated_at) VALUES
  ('hk-room-302','prop-seoul','room-302','2026-07-16','PENDING',2,NULL,'',clock_timestamp()),
  ('hk-room-317','prop-seoul','room-317','2026-07-16','IN_PROGRESS',1,'이수진','우선 정비',clock_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO idempotency_keys(key,property_id,action,actor,created_at) VALUES
  ('system:inventory-night-backfill-v1','prop-seoul','SYSTEM_BACKFILL','system',clock_timestamp()),
  ('system:inventory-triggers-v2','prop-seoul','SYSTEM_DDL','system',clock_timestamp()),
  ('system:group-triggers-v2','prop-seoul','SYSTEM_DDL','system',clock_timestamp()),
  ('system:financial-triggers-v2','prop-seoul','SYSTEM_DDL','system',clock_timestamp())
-- Target-less conflict handling remains valid both before and after migration 010
-- changes the key from global to property-scoped uniqueness.
ON CONFLICT DO NOTHING;

-- Website projection seed belongs here rather than in a schema migration. The
-- migration runner applies every schema migration before this file, so a pristine
-- database has its property and room types available when CMS rows are projected.
INSERT INTO website_settings(
  property_id,hotel_name,brand_eyebrow,hero_title,hero_subtitle,
  overview_title,overview_body,experience_title,experience_body,
  location_title,location_body,address,phone,email,checkin_time,
  checkout_time,published,version,updated_at,updated_by
)
SELECT
  p.id,'Seoul Sample Hotel','URBAN NIGHTS, QUIETLY BRIGHT',
  'A quiet glow in the heart of Seoul',
  'Thoughtful rooms and warm service for a clearer stay.',
  'Rooms designed around your time',
  'Calm circulation, soft light, and practical details support both rest and focus.',
  'From breakfast to the late lounge',
  'Dining, lounge, and fitness experiences follow the natural pace of your stay.',
  'A bright starting point in Seoul',
  'Business, culture, and dining districts are within easy reach.',
  '112-7 Changgyeonggung-ro, Jongno-gu, Seoul','02-0000-2026','stay@example.com',
  '15:00','11:00','1',1,clock_timestamp(),'system:seed'
FROM properties p
WHERE p.id='prop-seoul'
ON CONFLICT (property_id) DO NOTHING;

DO $seed_room_website$
BEGIN
  IF (SELECT data_type='boolean' FROM information_schema.columns WHERE table_schema='public' AND table_name='room_type_website' AND column_name='published') THEN
    INSERT INTO room_type_website(property_id,room_type_id,published,display_order,marketing_name,short_description,long_description,amenities_json,version,updated_at,updated_by)
    SELECT rt.property_id,rt.id,rt.code IN ('STWN','SDBL','FTWN','TRPL','PTWN','PDBL','PFTWN','SUITE'),row_number() OVER (PARTITION BY rt.property_id ORDER BY rt.base_rate,rt.code)-1,rt.name,rt.description,rt.description,'["Complimentary Wi-Fi","Smart TV","Premium bedding"]',1,clock_timestamp(),'system:seed'
    FROM room_types rt WHERE rt.property_id='prop-seoul' AND rt.active
    ON CONFLICT (property_id,room_type_id) DO NOTHING;
  ELSE
    INSERT INTO room_type_website(property_id,room_type_id,published,display_order,marketing_name,short_description,long_description,amenities_json,version,updated_at,updated_by)
    SELECT rt.property_id,rt.id,CASE WHEN rt.code IN ('STWN','SDBL','FTWN','TRPL','PTWN','PDBL','PFTWN','SUITE') THEN 1 ELSE 0 END,row_number() OVER (PARTITION BY rt.property_id ORDER BY rt.base_rate,rt.code)-1,rt.name,rt.description,rt.description,'["Complimentary Wi-Fi","Smart TV","Premium bedding"]',1,clock_timestamp(),'system:seed'
    FROM room_types rt WHERE rt.property_id='prop-seoul' AND rt.active=1
    ON CONFLICT (property_id,room_type_id) DO NOTHING;
  END IF;
END
$seed_room_website$;

-- Extended accounting was introduced after the base property schema. Re-project
-- the chart of accounts here so a pristine database receives the same starter
-- ledger configuration as an already-seeded database upgraded by the migration.
INSERT INTO accounting_accounts(
  id,property_id,code,name,account_type,category,department,created_at,updated_at
)
SELECT
  'acct-'||p.id||'-'||v.code,p.id,v.code,v.name,v.account_type,v.category,
  v.department,clock_timestamp(),clock_timestamp()
FROM properties p
CROSS JOIN (VALUES
  ('1100','Cash and deposits','ASSET','CASH','FINANCE'),
  ('1200','Channel receivables','ASSET','CHANNEL_RECEIVABLE','FINANCE'),
  ('1300','Accounts receivable','ASSET','ACCOUNTS_RECEIVABLE','FINANCE'),
  ('2100','Accounts payable','LIABILITY','ACCOUNTS_PAYABLE','FINANCE'),
  ('2200','Channel commission payable','LIABILITY','CHANNEL_COMMISSION_PAYABLE','FINANCE'),
  ('2300','Tax payable','LIABILITY','TAX_PAYABLE','FINANCE'),
  ('4100','Room revenue','REVENUE','ROOM_REVENUE','ROOMS'),
  ('4200','Other operating revenue','REVENUE','OTHER_REVENUE','OPERATIONS'),
  ('5100','Channel distribution expense','EXPENSE','CHANNEL_DISTRIBUTION','SALES'),
  ('5200','Hotel operating expense','EXPENSE','OPERATING_EXPENSE','OPERATIONS'),
  ('5990','Adjustment gain or loss','EXPENSE','ADJUSTMENT','FINANCE')
) AS v(code,name,account_type,category,department)
ON CONFLICT (property_id,code) DO NOTHING;
