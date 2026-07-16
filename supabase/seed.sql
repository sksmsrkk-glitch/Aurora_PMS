-- Idempotent starter property for Aurora PMS. Operational changes remain in the application audit log.
INSERT INTO properties(id,name,code,timezone,currency,business_date)
VALUES ('prop-seoul','오로라 서울 호텔','SEL01','Asia/Seoul','KRW','2026-07-16')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_assignments(id,property_id,email,role,active,created_at) VALUES
  ('role-local-admin','prop-seoul','frontdesk@aurora.hotel','PROPERTY_ADMIN',1,clock_timestamp()::text)
ON CONFLICT (property_id,email) DO NOTHING;

INSERT INTO room_types(id,property_id,code,name,base_rate,capacity,description,active,version) VALUES
  ('rt-dlx','prop-seoul','DLX','디럭스 킹',198000,2,'킹베드 기반의 대표 객실',1,1),
  ('rt-twn','prop-seoul','TWN','프리미어 트윈',228000,3,'가족 및 비즈니스 고객용 트윈',1,1),
  ('rt-ste','prop-seoul','STE','시티 스위트',420000,4,'거실과 침실이 분리된 스위트',1,1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rooms(id,property_id,room_type_id,number,floor,front_desk_status,housekeeping_status,features,version,active) VALUES
  ('room-101','prop-seoul','rt-dlx','101',1,'VACANT','CLEAN','["금연"]',1,1),
  ('room-102','prop-seoul','rt-dlx','102',1,'VACANT','DIRTY','["금연"]',1,1),
  ('room-103','prop-seoul','rt-twn','103',1,'VACANT','INSPECTED','["금연"]',1,1),
  ('room-201','prop-seoul','rt-dlx','201',2,'OCCUPIED','CLEAN','["금연"]',1,1),
  ('room-202','prop-seoul','rt-twn','202',2,'VACANT','CLEAN','["금연"]',1,1),
  ('room-203','prop-seoul','rt-twn','203',2,'VACANT','DIRTY','["금연"]',1,1),
  ('room-301','prop-seoul','rt-ste','301',3,'VACANT','INSPECTED','["시티뷰","고층"]',1,1),
  ('room-302','prop-seoul','rt-ste','302',3,'VACANT','OUT_OF_SERVICE','["시티뷰","고층"]',1,1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO guests(id,property_id,first_name,last_name,email,phone,vip_level,nationality,preferences,created_at) VALUES
  ('g1','prop-seoul','민지','김','g1@example.com','010-2011-8800','GOLD','KR','["고층","조용한 객실"]',clock_timestamp()::text),
  ('g2','prop-seoul','Sofia','Martinez','g2@example.com','010-2012-8800','NONE','ES','[]',clock_timestamp()::text),
  ('g3','prop-seoul','서연','박','g3@example.com','010-2013-8800','PLATINUM','KR','["고층","조용한 객실"]',clock_timestamp()::text),
  ('g4','prop-seoul','David','Chen','g4@example.com','010-2014-8800','SILVER','US','["공항 픽업"]',clock_timestamp()::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reservations(id,confirmation_no,property_id,guest_id,room_type_id,room_id,arrival_date,departure_date,status,adults,children,source,rate_plan,nightly_rate,eta,notes,version,created_at,updated_at) VALUES
  ('r1','SEL-260716-0184','prop-seoul','g1','rt-dlx','room-101','2026-07-16','2026-07-17','DUE_IN',2,0,'Direct','BAR',198000,'14:00','',1,clock_timestamp()::text,clock_timestamp()::text),
  ('r2','SEL-260716-0191','prop-seoul','g2','rt-twn','room-103','2026-07-16','2026-07-17','DUE_IN',2,1,'Booking.com','OTA',228000,'15:30','',1,clock_timestamp()::text,clock_timestamp()::text),
  ('r3','SEL-260715-0168','prop-seoul','g3','rt-dlx','room-201','2026-07-15','2026-07-18','IN_HOUSE',1,0,'Corporate','CORP',198000,NULL,'',1,clock_timestamp()::text,clock_timestamp()::text),
  ('r4','SEL-260716-0202','prop-seoul','g4','rt-ste',NULL,'2026-07-16','2026-07-17','DUE_IN',2,0,'Expedia','OTA',420000,'17:00','Late arrival · airport transfer',1,clock_timestamp()::text,clock_timestamp()::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date)
SELECT seed.* FROM (VALUES
  ('prop-seoul','r1','rt-dlx','2026-07-16'),
  ('prop-seoul','r2','rt-twn','2026-07-16'),
  ('prop-seoul','r3','rt-dlx','2026-07-15'),
  ('prop-seoul','r3','rt-dlx','2026-07-16'),
  ('prop-seoul','r3','rt-dlx','2026-07-17'),
  ('prop-seoul','r4','rt-ste','2026-07-16')
) AS seed(property_id,reservation_id,room_type_id,stay_date)
WHERE NOT EXISTS (SELECT 1 FROM reservation_type_nights existing WHERE existing.reservation_id=seed.reservation_id AND existing.stay_date=seed.stay_date);

INSERT INTO reservation_nights(property_id,reservation_id,room_id,stay_date) VALUES
  ('prop-seoul','r1','room-101','2026-07-16'),
  ('prop-seoul','r2','room-103','2026-07-16'),
  ('prop-seoul','r3','room-201','2026-07-15'),
  ('prop-seoul','r3','room-201','2026-07-16'),
  ('prop-seoul','r3','room-201','2026-07-17')
ON CONFLICT (property_id,room_id,stay_date) DO NOTHING;

INSERT INTO folio_windows(id,property_id,reservation_id,window_no,name,payee_type,payee_account_profile_id,status,created_at,created_by,closed_at) VALUES
  ('fw-r1','prop-seoul','r1',1,'Guest Folio','GUEST',NULL,'OPEN',clock_timestamp()::text,'system',NULL),
  ('fw-r2','prop-seoul','r2',1,'Guest Folio','GUEST',NULL,'OPEN',clock_timestamp()::text,'system',NULL),
  ('fw-r3','prop-seoul','r3',1,'Guest Folio','GUEST',NULL,'OPEN',clock_timestamp()::text,'system',NULL),
  ('fw-r4','prop-seoul','r4',1,'Guest Folio','GUEST',NULL,'OPEN',clock_timestamp()::text,'system',NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO transaction_codes(id,property_id,code,name,category,tax_rate,service_rate,active) VALUES
  ('tc-room','prop-seoul','ROOM','객실료','ROOM',10,0,1),
  ('tc-fnb','prop-seoul','FNB','식음료','FNB',10,0,1),
  ('tc-cash','prop-seoul','CASH','현금','PAYMENT',0,0,1),
  ('tc-card','prop-seoul','CARD','신용카드','PAYMENT',0,0,1),
  ('tc-direct-bill','prop-seoul','DIRECT_BILL','후불 이관','PAYMENT',0,0,1)
ON CONFLICT (property_id,code) DO NOTHING;

INSERT INTO folio_entries(id,property_id,reservation_id,kind,code,description,amount,payment_method,business_date,created_at,created_by,reverses_entry_id)
VALUES ('fe1','prop-seoul','r3','CHARGE','ROOM','객실료',198000,NULL,'2026-07-15',clock_timestamp()::text,'night-audit',NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO folio_entry_details(entry_id,property_id,reservation_id,folio_window_id,net_amount,tax_amount,service_amount,currency,source_entry_id,reason,created_at)
VALUES ('fe1','prop-seoul','r3','fw-r3',180000,18000,0,'KRW',NULL,'숙박 객실료',clock_timestamp()::text)
ON CONFLICT (entry_id) DO NOTHING;

INSERT INTO housekeeping_tasks(id,property_id,room_id,business_date,status,priority,assignee,notes,updated_at) VALUES
  ('hk102','prop-seoul','room-102','2026-07-16','IN_PROGRESS',1,'이수진','우선 정비',clock_timestamp()::text),
  ('hk203','prop-seoul','room-203','2026-07-16','PENDING',2,NULL,'',clock_timestamp()::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO idempotency_keys(key,property_id,action,actor,created_at) VALUES
  ('system:inventory-night-backfill-v1','prop-seoul','SYSTEM_BACKFILL','system',clock_timestamp()::text),
  ('system:inventory-triggers-v2','prop-seoul','SYSTEM_DDL','system',clock_timestamp()::text),
  ('system:group-triggers-v2','prop-seoul','SYSTEM_DDL','system',clock_timestamp()::text),
  ('system:financial-triggers-v2','prop-seoul','SYSTEM_DDL','system',clock_timestamp()::text)
ON CONFLICT (key) DO NOTHING;
