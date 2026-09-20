-- Why is a city only partly covered? Read-only.
select 'REPORT AREAS (what the refresh job fetches around)' as section;
select round(lat::numeric,1) as lat, round(lng::numeric,1) as lng,
       count(*) as reports, min(city) as city
  from public.reports where status='published'
 group by 1,2 order by 3 desc;

select 'SAFETY PLACES NEAR LEIPZIG (51.34, 12.37)' as section;
select kind, count(*) as n,
       round(min(lat)::numeric,3) as south, round(max(lat)::numeric,3) as north,
       round(min(lng)::numeric,3) as west,  round(max(lng)::numeric,3) as east
  from public.safety_places
 where lat between 51.2 and 51.5 and lng between 12.2 and 12.6
 group by kind;

select 'HOW FAR THEY REACH FROM THE REPORT CENTRE' as section;
select kind, name,
       round((6371 * acos(least(1, cos(radians(51.34)) * cos(radians(lat))
            * cos(radians(lng) - radians(12.37)) + sin(radians(51.34)) * sin(radians(lat)))))::numeric, 1) as km_from_centre
  from public.safety_places
 where lat between 51.2 and 51.5 and lng between 12.2 and 12.6
 order by km_from_centre desc limit 12;
