-- Replace QA-generated room masters with the canonical eight-type, 160-room
-- sample hotel. Historical reservations and rate nights are retained, but any
-- obsolete type reference is mapped to a supported room type before deletion.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';

CREATE TEMP TABLE talos_inventory_0036_before ON COMMIT DROP AS
SELECT
  p.id property_id,
  (SELECT count(*) FROM public.room_types rt WHERE rt.property_id=p.id) room_types,
  (SELECT count(*) FROM public.rooms rm WHERE rm.property_id=p.id) rooms,
  (SELECT count(*) FROM public.reservations r WHERE r.property_id=p.id) reservations,
  (SELECT count(*) FROM public.room_moves m WHERE m.property_id=p.id) room_moves,
  (SELECT count(*) FROM public.housekeeping_tasks h WHERE h.property_id=p.id) housekeeping_tasks
FROM public.properties p
WHERE p.id='prop-seoul';

INSERT INTO public.room_types AS existing(
  id,property_id,code,name,base_rate,capacity,description,active,version
)
SELECT target.*
FROM (VALUES
  ('rt-standard-twin','prop-seoul','STWN','Standard Twin Room',160000::numeric,2,'싱글 베드 2개를 갖춘 실용적인 스탠다드 객실',true,1),
  ('rt-dlx','prop-seoul','SDBL','Standard Double Room',170000::numeric,2,'더블 베드 1개를 갖춘 편안한 스탠다드 객실',true,1),
  ('rt-family-twin','prop-seoul','FTWN','Family Twin Room',210000::numeric,3,'더블 베드와 싱글 베드를 갖춘 가족형 객실',true,1),
  ('rt-triple','prop-seoul','TRPL','Triple Room',230000::numeric,3,'3인이 편안하게 머무를 수 있는 트리플 객실',true,1),
  ('rt-twn','prop-seoul','PTWN','Premier Twin Room',240000::numeric,2,'상층부에 위치한 프리미어 트윈 객실',true,1),
  ('rt-premier-double','prop-seoul','PDBL','Premier Double Room',250000::numeric,2,'상층부에 위치한 프리미어 더블 객실',true,1),
  ('rt-premier-family-twin','prop-seoul','PFTWN','Premier Family Twin Room',290000::numeric,3,'넓은 공간과 상층 전망을 갖춘 프리미어 가족형 객실',true,1),
  ('rt-ste','prop-seoul','SUITE','Suite Room',420000::numeric,4,'침실과 휴식 공간이 분리된 최상층 스위트 객실',true,1)
) target(id,property_id,code,name,base_rate,capacity,description,active,version)
WHERE EXISTS(SELECT 1 FROM public.properties p WHERE p.id=target.property_id)
ON CONFLICT(id) DO UPDATE SET
  code=excluded.code,
  name=excluded.name,
  base_rate=excluded.base_rate,
  capacity=excluded.capacity,
  description=excluded.description,
  active=true,
  version=existing.version+1;

CREATE TEMP TABLE talos_room_type_0036_map(
  old_id text PRIMARY KEY,
  target_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO talos_room_type_0036_map(old_id,target_id)
SELECT
  rt.id,
  CASE rt.code
    WHEN 'DLX' THEN 'rt-dlx'
    WHEN 'TWN' THEN 'rt-twn'
    WHEN 'STE' THEN 'rt-ste'
    ELSE 'rt-standard-twin'
  END
FROM public.room_types rt
WHERE rt.property_id='prop-seoul'
  AND rt.id NOT IN (
    'rt-standard-twin','rt-dlx','rt-family-twin','rt-triple',
    'rt-twn','rt-premier-double','rt-premier-family-twin','rt-ste'
  );

-- Room-level QA artifacts cannot be carried to a new physical room master.
-- Reservations remain intact and are deliberately returned to the unassigned
-- queue; the four stable starter reservations are reassigned below.
UPDATE public.reservations
SET room_id=NULL,version=version+1,updated_at=clock_timestamp()
WHERE property_id='prop-seoul' AND room_id IS NOT NULL;

DELETE FROM public.room_moves WHERE property_id='prop-seoul';
DELETE FROM public.housekeeping_tasks WHERE property_id='prop-seoul';
DELETE FROM public.reservation_nights WHERE property_id='prop-seoul';

-- Preserve reservation and revenue history under the simplified room catalog.
UPDATE public.reservations r
SET room_type_id=m.target_id,version=r.version+1,updated_at=clock_timestamp()
FROM talos_room_type_0036_map m
WHERE r.property_id='prop-seoul' AND r.room_type_id=m.old_id;

DO $assert_immutable_rate_history$
BEGIN
  IF EXISTS(
    SELECT 1
    FROM public.reservation_rate_nights n
    JOIN talos_room_type_0036_map m ON m.old_id=n.room_type_id
    WHERE n.property_id='prop-seoul'
  ) THEN
    RAISE EXCEPTION
      'obsolete QA room types still own immutable reservation rate snapshots';
  END IF;
END
$assert_immutable_rate_history$;

UPDATE public.reservation_type_nights n
SET room_type_id=m.target_id
FROM talos_room_type_0036_map m
WHERE n.property_id='prop-seoul' AND n.room_type_id=m.old_id;

-- QA group allocations are synthetic and may collapse onto the same target
-- type/date unique key. Remove only their obsolete type-specific projections.
DELETE FROM public.block_pickup_nights n
USING talos_room_type_0036_map m
WHERE n.property_id='prop-seoul' AND n.room_type_id=m.old_id;

DELETE FROM public.block_inventory i
USING talos_room_type_0036_map m
WHERE i.property_id='prop-seoul' AND i.room_type_id=m.old_id;

DELETE FROM public.rooming_list_entries e
USING talos_room_type_0036_map m
WHERE e.property_id='prop-seoul' AND e.room_type_id=m.old_id;

DELETE FROM public.inventory_controls i
USING talos_room_type_0036_map m
WHERE i.property_id='prop-seoul' AND i.room_type_id=m.old_id;

-- Keep the legacy physical rooms in place until pickup projections are gone.
-- The pickup DELETE trigger recalculates held stock against physical capacity;
-- deleting rooms first would make that valid cleanup look oversold.
DELETE FROM public.rooms WHERE property_id='prop-seoul';

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
    sequence,
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
INSERT INTO public.rooms(
  id,property_id,room_type_id,number,floor,front_desk_status,
  housekeeping_status,features,version,active
)
SELECT
  'room-'||number,
  property_row.id,
  room_type_id,
  number,
  floor,
  'VACANT',
  'CLEAN',
  CASE
    WHEN room_type_id='rt-ste' THEN '["금연","고층","스위트"]'::jsonb
    WHEN floor>=6 THEN '["금연","고층"]'::jsonb
    ELSE '["금연"]'::jsonb
  END,
  1,
  true
FROM room_plan
CROSS JOIN public.properties property_row
WHERE property_row.id='prop-seoul';

UPDATE public.channel_mappings c
SET room_type_id=m.target_id,updated_at=clock_timestamp()
FROM talos_room_type_0036_map m
WHERE c.property_id='prop-seoul' AND c.room_type_id=m.old_id;

UPDATE public.channel_rate_overrides o
SET room_type_id=c.room_type_id,updated_at=clock_timestamp(),updated_by='system:migration'
FROM public.channel_mappings c
WHERE o.property_id='prop-seoul'
  AND c.property_id=o.property_id
  AND c.id=o.mapping_id
  AND o.room_type_id<>c.room_type_id;

DELETE FROM public.room_types rt
USING talos_room_type_0036_map m
WHERE rt.property_id='prop-seoul' AND rt.id=m.old_id;

-- Every active rate plan and public website room now projects the same eight
-- canonical types. Day-level rates continue to use the SQL rate resolver.
INSERT INTO public.rate_plan_room_types AS existing(
  property_id,rate_plan_id,room_type_id,base_rate,active,version,updated_at,updated_by
)
SELECT
  rp.property_id,rp.id,rt.id,rt.base_rate,true,1,clock_timestamp(),'system:migration'
FROM public.rate_plans rp
JOIN public.room_types rt ON rt.property_id=rp.property_id
WHERE rp.property_id='prop-seoul' AND rt.active
ON CONFLICT(property_id,rate_plan_id,room_type_id) DO UPDATE SET
  base_rate=excluded.base_rate,
  active=true,
  version=existing.version+1,
  updated_at=excluded.updated_at,
  updated_by=excluded.updated_by;

INSERT INTO public.room_type_website AS existing(
  property_id,room_type_id,published,display_order,marketing_name,
  short_description,long_description,amenities_json,version,updated_at,updated_by
)
SELECT
  rt.property_id,
  rt.id,
  true,
  CASE rt.code
    WHEN 'STWN' THEN 1 WHEN 'SDBL' THEN 2 WHEN 'FTWN' THEN 3
    WHEN 'TRPL' THEN 4 WHEN 'PTWN' THEN 5 WHEN 'PDBL' THEN 6
    WHEN 'PFTWN' THEN 7 ELSE 8
  END,
  rt.name,
  rt.description,
  rt.description,
  '["Complimentary Wi-Fi","Smart TV","Premium bedding","Non-smoking"]'::jsonb,
  1,
  clock_timestamp(),
  'system:migration'
FROM public.room_types rt
WHERE rt.property_id='prop-seoul' AND rt.active
ON CONFLICT(property_id,room_type_id) DO UPDATE SET
  published=true,
  display_order=excluded.display_order,
  marketing_name=excluded.marketing_name,
  short_description=excluded.short_description,
  long_description=excluded.long_description,
  amenities_json=excluded.amenities_json,
  version=existing.version+1,
  updated_at=excluded.updated_at,
  updated_by=excluded.updated_by;

-- Restore useful starter assignments without carrying QA-generated room moves.
UPDATE public.reservations
SET
  room_id=CASE id
    WHEN 'r1' THEN 'room-315'
    WHEN 'r2' THEN 'room-325'
    WHEN 'r3' THEN 'room-316'
  END,
  room_type_id=CASE id
    WHEN 'r1' THEN 'rt-dlx'
    WHEN 'r2' THEN 'rt-family-twin'
    WHEN 'r3' THEN 'rt-dlx'
  END,
  version=version+1,
  updated_at=clock_timestamp()
WHERE property_id='prop-seoul' AND id IN ('r1','r2','r3');

INSERT INTO public.reservation_nights(property_id,reservation_id,room_id,stay_date)
SELECT
  r.property_id,r.id,r.room_id,day::date
FROM public.reservations r
CROSS JOIN LATERAL generate_series(
  r.arrival_date,r.departure_date-1,interval '1 day'
) day
WHERE r.property_id='prop-seoul'
  AND r.id IN ('r1','r2','r3')
  AND r.room_id IS NOT NULL
ON CONFLICT(property_id,room_id,stay_date) DO NOTHING;

UPDATE public.rooms
SET front_desk_status='OCCUPIED',version=version+1
WHERE property_id='prop-seoul'
  AND id='room-316'
  AND EXISTS (
    SELECT 1 FROM public.reservations r
    WHERE r.property_id='prop-seoul' AND r.id='r3' AND r.status='IN_HOUSE'
  );

INSERT INTO public.housekeeping_tasks(
  id,property_id,room_id,business_date,status,priority,assignee,notes,updated_at
)
SELECT
  task.id,p.id,task.room_id,p.business_date,task.status,task.priority,
  task.assignee,task.notes,clock_timestamp()
FROM public.properties p
CROSS JOIN (VALUES
  ('hk-room-302','room-302','PENDING',2,NULL::text,''),
  ('hk-room-317','room-317','IN_PROGRESS',1,'이수진','우선 정비')
) task(id,room_id,status,priority,assignee,notes)
WHERE p.id='prop-seoul'
ON CONFLICT(id) DO UPDATE SET
  room_id=excluded.room_id,
  business_date=excluded.business_date,
  status=excluded.status,
  priority=excluded.priority,
  assignee=excluded.assignee,
  notes=excluded.notes,
  updated_at=excluded.updated_at;

DO $assert_sample_inventory$
DECLARE
  type_count integer;
  room_count integer;
  invalid_type_count integer;
  invalid_floor_count integer;
  invalid_distribution_count integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.properties WHERE id='prop-seoul') THEN
    RETURN;
  END IF;

  SELECT count(*) INTO type_count
  FROM public.room_types WHERE property_id='prop-seoul';
  SELECT count(*) INTO room_count
  FROM public.rooms WHERE property_id='prop-seoul' AND active;
  SELECT count(*) INTO invalid_type_count
  FROM public.room_types
  WHERE property_id='prop-seoul'
    AND name NOT IN (
      'Standard Twin Room','Standard Double Room','Family Twin Room','Triple Room',
      'Premier Twin Room','Premier Double Room','Premier Family Twin Room','Suite Room'
    );
  SELECT count(*) INTO invalid_floor_count
  FROM public.rooms
  WHERE property_id='prop-seoul' AND (floor NOT BETWEEN 3 AND 8 OR number !~ '^[3-8][0-9]{2}$');
  SELECT count(*) INTO invalid_distribution_count
  FROM (
    VALUES
      ('rt-standard-twin',28),('rt-dlx',28),
      ('rt-family-twin',18),('rt-triple',14),
      ('rt-twn',22),('rt-premier-double',22),
      ('rt-premier-family-twin',16),('rt-ste',12)
  ) expected(room_type_id,rooms)
  LEFT JOIN (
    SELECT room_type_id,count(*)::integer rooms
    FROM public.rooms
    WHERE property_id='prop-seoul' AND active
    GROUP BY room_type_id
  ) actual USING(room_type_id)
  WHERE actual.rooms IS DISTINCT FROM expected.rooms;

  IF type_count<>8 OR room_count<>160 OR invalid_type_count<>0
     OR invalid_floor_count<>0 OR invalid_distribution_count<>0 THEN
    RAISE EXCEPTION
      'sample inventory invariant failed: types %, rooms %, names %, floors %, distribution %',
      type_count,room_count,invalid_type_count,invalid_floor_count,invalid_distribution_count;
  END IF;
END
$assert_sample_inventory$;

INSERT INTO public.audit_logs(
  id,property_id,actor,action,entity_type,entity_id,
  before_json,after_json,created_at
)
SELECT
  'migration-0036-room-catalog-'||md5(before_state.property_id),
  before_state.property_id,
  'system:migration',
  'SAMPLE_ROOM_CATALOG_REBUILT',
  'property',
  before_state.property_id,
  jsonb_build_object(
    'roomTypes',before_state.room_types,
    'rooms',before_state.rooms,
    'reservations',before_state.reservations,
    'roomMoves',before_state.room_moves,
    'housekeepingTasks',before_state.housekeeping_tasks
  ),
  jsonb_build_object(
    'roomTypes',8,
    'rooms',160,
    'floors',jsonb_build_array(3,4,5,6,7,8),
    'legacyRoomTypes',0
  ),
  clock_timestamp()
FROM talos_inventory_0036_before before_state
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607230036_sample_hotel_room_catalog')
ON CONFLICT(id) DO NOTHING;

COMMIT;
