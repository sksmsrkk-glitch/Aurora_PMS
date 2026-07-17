-- Visual website editor: hero art direction, safe section navigation and CTA controls.
BEGIN;

ALTER TABLE public.website_settings
  ADD COLUMN IF NOT EXISTS hero_media_id text,
  ADD COLUMN IF NOT EXISTS hero_layout text NOT NULL DEFAULT 'LEFT',
  ADD COLUMN IF NOT EXISTS hero_overlay integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS hero_height integer NOT NULL DEFAULT 720,
  ADD COLUMN IF NOT EXISTS hero_cta_label text NOT NULL DEFAULT '객실 둘러보기',
  ADD COLUMN IF NOT EXISTS hero_cta_href text NOT NULL DEFAULT '#stay',
  ADD COLUMN IF NOT EXISTS booking_cta_label text NOT NULL DEFAULT '예약하기',
  ADD COLUMN IF NOT EXISTS theme_accent text NOT NULL DEFAULT '#2764E7',
  ADD COLUMN IF NOT EXISTS navigation_json jsonb NOT NULL DEFAULT '[{"id":"stay","label":"STAY","enabled":true},{"id":"experience","label":"EXPERIENCE","enabled":true},{"id":"location","label":"LOCATION","enabled":true}]'::jsonb;

ALTER TABLE public.website_settings
  DROP CONSTRAINT IF EXISTS website_settings_hero_layout_check,
  ADD CONSTRAINT website_settings_hero_layout_check CHECK (hero_layout IN ('LEFT','CENTER','SPLIT')),
  DROP CONSTRAINT IF EXISTS website_settings_hero_overlay_check,
  ADD CONSTRAINT website_settings_hero_overlay_check CHECK (hero_overlay BETWEEN 0 AND 90),
  DROP CONSTRAINT IF EXISTS website_settings_hero_height_check,
  ADD CONSTRAINT website_settings_hero_height_check CHECK (hero_height BETWEEN 520 AND 960),
  DROP CONSTRAINT IF EXISTS website_settings_hero_cta_href_check,
  ADD CONSTRAINT website_settings_hero_cta_href_check CHECK (hero_cta_href IN ('#stay','#experience','#location','/hotel/book')),
  DROP CONSTRAINT IF EXISTS website_settings_theme_accent_check,
  ADD CONSTRAINT website_settings_theme_accent_check CHECK (theme_accent ~ '^#[0-9A-Fa-f]{6}$'),
  DROP CONSTRAINT IF EXISTS website_settings_navigation_json_check,
  ADD CONSTRAINT website_settings_navigation_json_check CHECK (jsonb_typeof(navigation_json)='array' AND jsonb_array_length(navigation_json)=3);

CREATE INDEX IF NOT EXISTS website_media_hero_lookup_idx
  ON public.website_media(property_id,id)
  WHERE scope='HOTEL' AND active;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170014_website_visual_editor')
ON CONFLICT (id) DO NOTHING;

COMMIT;
