-- Preserve the original three-room public launch while keeping every PMS room
-- type available for an administrator to publish from Website Studio.
BEGIN;
UPDATE public.room_type_website rw
SET published=CASE WHEN rt.code IN ('DLX','TWN','STE') THEN 1 ELSE 0 END,
    version=rw.version+1,
    updated_at=now()::text,
    updated_by='system:website-launch'
FROM public.room_types rt
WHERE rt.property_id=rw.property_id AND rt.id=rw.room_type_id;
INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607170005_website_seed_visibility')
ON CONFLICT (id) DO NOTHING;
COMMIT;
