-- Aurora Hotel website CMS, public room merchandising and direct-channel controls.
BEGIN;

ALTER TABLE public.inventory_controls
  ADD COLUMN IF NOT EXISTS website_closed integer NOT NULL DEFAULT 0
  CHECK (website_closed IN (0,1));

CREATE TABLE IF NOT EXISTS public.website_settings (
  property_id text PRIMARY KEY REFERENCES public.properties(id) ON DELETE RESTRICT,
  hotel_name text NOT NULL,
  brand_eyebrow text NOT NULL,
  hero_title text NOT NULL,
  hero_subtitle text NOT NULL,
  overview_title text NOT NULL,
  overview_body text NOT NULL,
  experience_title text NOT NULL,
  experience_body text NOT NULL,
  location_title text NOT NULL,
  location_body text NOT NULL,
  address text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL,
  checkin_time text NOT NULL DEFAULT '15:00',
  checkout_time text NOT NULL DEFAULT '11:00',
  published integer NOT NULL DEFAULT 1 CHECK (published IN (0,1)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at text NOT NULL,
  updated_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.room_type_website (
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  room_type_id text NOT NULL,
  published integer NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  marketing_name text NOT NULL,
  short_description text NOT NULL,
  long_description text NOT NULL,
  amenities_json text NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at text NOT NULL,
  updated_by text NOT NULL,
  PRIMARY KEY(property_id,room_type_id),
  CONSTRAINT room_type_website_type_fk FOREIGN KEY(property_id,room_type_id)
    REFERENCES public.room_types(property_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.website_media (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('HOTEL','ROOM_TYPE')),
  room_type_id text,
  role text NOT NULL CHECK (role IN ('HERO','GALLERY','CARD')),
  object_path text NOT NULL,
  public_url text NOT NULL,
  alt_text text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  created_by text NOT NULL,
  CONSTRAINT website_media_scope_room_check CHECK (
    (scope='HOTEL' AND room_type_id IS NULL) OR
    (scope='ROOM_TYPE' AND room_type_id IS NOT NULL)
  ),
  CONSTRAINT website_media_type_fk FOREIGN KEY(property_id,room_type_id)
    REFERENCES public.room_types(property_id,id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS room_type_website_public_idx
  ON public.room_type_website(property_id,published,display_order);
CREATE INDEX IF NOT EXISTS website_media_public_idx
  ON public.website_media(property_id,scope,room_type_id,active,sort_order);
CREATE INDEX IF NOT EXISTS inventory_website_calendar_idx
  ON public.inventory_controls(property_id,room_type_id,stay_date,website_closed);

ALTER TABLE public.website_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_type_website ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.website_settings FROM anon, authenticated;
REVOKE ALL ON TABLE public.room_type_website FROM anon, authenticated;
REVOKE ALL ON TABLE public.website_media FROM anon, authenticated;

-- Images are written only with the server-side service key; the bucket itself is
-- public so optimized hotel pages can render image URLs without signed-link churn.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('hotel-media','hotel-media',true,8388608,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

INSERT INTO public.website_settings(
  property_id,hotel_name,brand_eyebrow,hero_title,hero_subtitle,
  overview_title,overview_body,experience_title,experience_body,
  location_title,location_body,address,phone,email,checkin_time,
  checkout_time,published,version,updated_at,updated_by
)
SELECT
  p.id,'Aurora Hotel Seoul','URBAN NIGHTS, QUIETLY BRIGHT',
  '도시의 밤이 가장 편안해지는 곳',
  '정제된 객실과 세심한 서비스. 서울의 리듬을 오롯이 누리는 새로운 스테이.',
  '머무는 시간에 집중한 객실',
  '과장된 장식 대신 편안한 동선, 부드러운 빛, 깊은 휴식을 설계했습니다.',
  '아침부터 깊은 밤까지 당신의 속도에 맞춰',
  '제철 조식, 선셋 라운지, 24시간 피트니스가 여행의 리듬을 지켜드립니다.',
  '서울을 만나는 가장 좋은 시작점',
  '비즈니스와 문화, 미식의 중심을 가볍게 잇습니다.',
  '서울특별시 중구 오로라로 1','02-0000-2026','stay@aurora.hotel',
  '15:00','11:00',1,1,now()::text,'system'
FROM public.properties p
WHERE p.id='prop-seoul'
ON CONFLICT (property_id) DO NOTHING;

INSERT INTO public.room_type_website(
  property_id,room_type_id,published,display_order,marketing_name,
  short_description,long_description,amenities_json,version,updated_at,updated_by
)
SELECT
  rt.property_id,rt.id,CASE WHEN rt.code IN ('DLX','TWN','STE') THEN 1 ELSE 0 END,
  row_number() OVER (PARTITION BY rt.property_id ORDER BY rt.base_rate,rt.code)-1,
  rt.name,rt.description,rt.description,
  '["무료 Wi-Fi","스마트 TV","프리미엄 침구"]',1,now()::text,'system'
FROM public.room_types rt
WHERE rt.property_id='prop-seoul' AND rt.active=1
ON CONFLICT (property_id,room_type_id) DO NOTHING;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170004_website_cms')
ON CONFLICT (id) DO NOTHING;

COMMIT;
