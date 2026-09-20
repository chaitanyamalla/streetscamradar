-- ---------------------------------------------------------------------------
-- Police stations and hospitals, stored rather than fetched live.
--
-- These were read straight from OpenStreetMap's Overpass API on every pan,
-- which made the layer only as reliable as a free, shared, frequently
-- congested service — and it was regularly neither fast nor available. They
-- now live here, refreshed by .github/workflows/safety-data.yml, so the page
-- reads them the same way it reads everything else: one indexed query against
-- our own database.
--
-- This is reference data, not user content: the same for everyone, readable
-- signed in or not, and never written from the browser.
-- ---------------------------------------------------------------------------
create table if not exists public.safety_places (
  id           text primary key,          -- OSM type/id, e.g. "node/12345"
  kind         text not null check (kind in ('police', 'hospital')),
  name         text not null,
  address      text,
  lat          double precision not null check (lat between -90 and 90),
  lng          double precision not null check (lng between -180 and 180),
  country_code char(2),
  updated_at   timestamptz not null default now()
);

create index if not exists safety_places_lat_idx on public.safety_places (lat);
create index if not exists safety_places_lng_idx on public.safety_places (lng);
create index if not exists safety_places_kind_idx on public.safety_places (kind);

alter table public.safety_places enable row level security;

-- Readable by everyone; writable by nobody through the API. The refresh
-- workflow connects as the database owner, which bypasses RLS.
drop policy if exists "safety places are public" on public.safety_places;
create policy "safety places are public" on public.safety_places
  for select to anon, authenticated using (true);

revoke insert, update, delete on table public.safety_places from anon, authenticated;

select 'safety_places ready' as step,
       (select count(*) from public.safety_places) as rows_now;
