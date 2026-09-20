-- ---------------------------------------------------------------------------
-- How much detail do the stored hospitals actually carry?
--
-- Read-only. The popup shows opening hours and a phone number when they are
-- there; this says how often OpenStreetMap has them at all.
-- ---------------------------------------------------------------------------
select 'coverage' as check,
       count(*)                                          as hospitals,
       count(opening_hours)                              as with_opening_hours,
       count(phone)                                      as with_phone,
       count(address)                                    as with_address,
       count(*) filter (where emergency)                 as with_emergency_dept,
       round(100.0 * count(opening_hours) / nullif(count(*), 0), 1) as pct_hours,
       round(100.0 * count(phone)         / nullif(count(*), 0), 1) as pct_phone
  from public.safety_places
 where kind = 'hospital';

-- What the hours look like where they exist, commonest first.
select 'sample hours' as check, opening_hours, count(*) as places
  from public.safety_places
 where kind = 'hospital' and opening_hours is not null
 group by opening_hours
 order by places desc
 limit 8;

-- A few named examples, so it is clear this is real data and not a shape.
select 'examples' as check, left(name, 40) as name, city_hint.city, opening_hours, phone
  from public.safety_places sp
  cross join lateral (select coalesce(sp.country_code, '--') as city) city_hint
 where kind = 'hospital' and opening_hours is not null and phone is not null
 order by name
 limit 8;
