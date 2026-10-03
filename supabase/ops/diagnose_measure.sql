-- What GDACS actually measures, per kind, now that we keep its own words.
select kind,
       count(*) as events,
       count(measure) as with_a_measurement,
       max(measure) as an_example
  from public.disaster_alerts
 group by kind
 order by 2 desc;
