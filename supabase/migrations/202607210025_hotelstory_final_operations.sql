-- HotelStory-compatible banquet, member, and dedicated stay-operation masters.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE public.banquet_venues (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  capacity integer NOT NULL,
  location text NOT NULL DEFAULT '',
  amenities jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT banquet_venue_code_check CHECK (code=upper(code) AND char_length(code) BETWEEN 1 AND 24),
  CONSTRAINT banquet_venue_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT banquet_venue_capacity_check CHECK (capacity BETWEEN 1 AND 10000),
  CONSTRAINT banquet_venue_location_check CHECK (char_length(location)<=180),
  CONSTRAINT banquet_venue_amenities_array CHECK (jsonb_typeof(amenities)='array'),
  CONSTRAINT banquet_venue_version_check CHECK (version>0),
  CONSTRAINT banquet_venue_property_id_uq UNIQUE(property_id,id),
  CONSTRAINT banquet_venue_property_code_uq UNIQUE(property_id,code)
);

CREATE TABLE public.banquet_reservations (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  venue_id text NOT NULL,
  event_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  event_name text NOT NULL,
  contact_name text NOT NULL,
  contact_phone text NOT NULL DEFAULT '',
  contact_email text,
  attendees integer NOT NULL DEFAULT 1,
  fee numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'TENTATIVE',
  notes text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT banquet_reservation_venue_fk FOREIGN KEY(property_id,venue_id)
    REFERENCES public.banquet_venues(property_id,id) ON DELETE RESTRICT,
  CONSTRAINT banquet_reservation_time_check CHECK (end_time>start_time),
  CONSTRAINT banquet_reservation_event_name_check CHECK (char_length(event_name) BETWEEN 1 AND 160),
  CONSTRAINT banquet_reservation_contact_name_check CHECK (char_length(contact_name) BETWEEN 1 AND 100),
  CONSTRAINT banquet_reservation_contact_phone_check CHECK (char_length(contact_phone)<=32),
  CONSTRAINT banquet_reservation_contact_email_check CHECK (contact_email IS NULL OR char_length(contact_email)<=254),
  CONSTRAINT banquet_reservation_attendees_check CHECK (attendees BETWEEN 1 AND 10000),
  CONSTRAINT banquet_reservation_fee_check CHECK (fee>=0),
  CONSTRAINT banquet_reservation_status_check CHECK (status IN ('TENTATIVE','CONFIRMED','COMPLETED','CANCELLED')),
  CONSTRAINT banquet_reservation_notes_check CHECK (char_length(notes)<=2000),
  CONSTRAINT banquet_reservation_version_check CHECK (version>0),
  CONSTRAINT banquet_reservation_property_id_uq UNIQUE(property_id,id)
);
CREATE INDEX banquet_reservation_calendar_idx
  ON public.banquet_reservations(property_id,event_date,venue_id,start_time);

-- A transaction-scoped advisory lock serializes checks for one venue/day.
-- Unlike a read-then-write API guard, concurrent requests cannot both pass.
CREATE FUNCTION public.pms_banquet_overlap_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('TENTATIVE','CONFIRMED') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.property_id||':'||NEW.venue_id||':'||NEW.event_date::text,0));
    IF EXISTS (
      SELECT 1 FROM public.banquet_reservations existing
       WHERE existing.property_id=NEW.property_id
         AND existing.venue_id=NEW.venue_id
         AND existing.event_date=NEW.event_date
         AND existing.status IN ('TENTATIVE','CONFIRMED')
         AND existing.id<>NEW.id
         AND NEW.start_time<existing.end_time
         AND NEW.end_time>existing.start_time
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23P01', MESSAGE='banquet venue time slot overlaps an active reservation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER banquet_reservation_overlap_guard
BEFORE INSERT OR UPDATE OF venue_id,event_date,start_time,end_time,status
ON public.banquet_reservations
FOR EACH ROW EXECUTE FUNCTION public.pms_banquet_overlap_guard();

CREATE TABLE public.hotel_members (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  member_no text NOT NULL,
  login_id text,
  website_user_id uuid,
  member_type text NOT NULL DEFAULT 'HOTEL',
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  email text,
  company text NOT NULL DEFAULT '',
  grade text NOT NULL DEFAULT 'GENERAL',
  administrator_type text NOT NULL DEFAULT 'NONE',
  active boolean NOT NULL DEFAULT true,
  joined_date date NOT NULL DEFAULT CURRENT_DATE,
  password_hash text,
  privacy jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_login_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  CONSTRAINT hotel_member_no_check CHECK (char_length(member_no) BETWEEN 1 AND 40),
  CONSTRAINT hotel_member_login_check CHECK (login_id IS NULL OR char_length(login_id) BETWEEN 4 AND 120),
  CONSTRAINT hotel_member_type_check CHECK (member_type IN ('HOTEL','WEBSITE','BOTH')),
  CONSTRAINT hotel_member_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT hotel_member_phone_check CHECK (char_length(phone)<=32),
  CONSTRAINT hotel_member_email_check CHECK (email IS NULL OR char_length(email)<=254),
  CONSTRAINT hotel_member_company_check CHECK (char_length(company)<=160),
  CONSTRAINT hotel_member_grade_check CHECK (char_length(grade) BETWEEN 1 AND 40),
  CONSTRAINT hotel_member_admin_type_check CHECK (administrator_type IN ('NONE','COMPANY','WEBSITE')),
  CONSTRAINT hotel_member_privacy_object CHECK (jsonb_typeof(privacy)='object'),
  CONSTRAINT hotel_member_version_check CHECK (version>0),
  CONSTRAINT hotel_member_property_id_uq UNIQUE(property_id,id),
  CONSTRAINT hotel_member_property_no_uq UNIQUE(property_id,member_no),
  CONSTRAINT hotel_member_property_login_uq UNIQUE(property_id,login_id)
);
CREATE INDEX hotel_member_search_idx
  ON public.hotel_members(property_id,active,joined_date DESC,name);
CREATE INDEX hotel_member_website_idx
  ON public.hotel_members(property_id,website_user_id) WHERE website_user_id IS NOT NULL;

ALTER TABLE public.banquet_venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banquet_venues FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.banquet_venues
  FOR ALL TO aurora_app
  USING (property_id=public.pms_current_property_id())
  WITH CHECK (property_id=public.pms_current_property_id());

ALTER TABLE public.banquet_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banquet_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.banquet_reservations
  FOR ALL TO aurora_app
  USING (property_id=public.pms_current_property_id())
  WITH CHECK (property_id=public.pms_current_property_id());

ALTER TABLE public.hotel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hotel_members FORCE ROW LEVEL SECURITY;
CREATE POLICY aurora_property_isolation ON public.hotel_members
  FOR ALL TO aurora_app
  USING (property_id=public.pms_current_property_id())
  WITH CHECK (property_id=public.pms_current_property_id());

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.banquet_venues TO aurora_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.banquet_reservations TO aurora_app;
GRANT SELECT,INSERT,UPDATE ON TABLE public.hotel_members TO aurora_app;
REVOKE ALL ON TABLE public.banquet_venues,public.banquet_reservations,public.hotel_members FROM anon,authenticated;

INSERT INTO public.pms_schema_migrations(id)
VALUES ('202607210025_hotelstory_final_operations')
ON CONFLICT(id) DO NOTHING;

COMMIT;
