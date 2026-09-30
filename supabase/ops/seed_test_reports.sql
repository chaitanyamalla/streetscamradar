-- ---------------------------------------------------------------------------
-- Sample scam reports, so the map has something on it.
--
-- Every row here is INVENTED. None of it happened, nobody filed it, and no
-- real person or business is being accused of anything. Each description opens
-- by saying so, because a reader who clicks a pin deserves to know what they
-- are looking at before they read the rest of it — not in a footnote, and not
-- only in this file, which they will never see.
--
-- The places are real and are the busy tourist spots the site is about, so the
-- map looks the way it will look in use: a pin at the Colosseum, one at Times
-- Square, one on La Rambla.
--
-- Written to be run more than once. The ids are fixed and start 7e57da7a
-- ("testdata"), so a re-run replaces these rows rather than adding another two
-- dozen, and `delete from public.reports where id::text like '7e57da7a%'`
-- removes every one of them and nothing else. supabase/ops/clear_test_reports.sql
-- does exactly that.
--
-- reporter_id is null: these belong to nobody, so no account is implicated and
-- deleting an account cannot take them with it.
--
-- happened_at is relative to now(), so they stay inside the seven-day window
-- whenever this is run. Run it again when they age out.
--
-- Run: Database workflow, file = supabase/ops/seed_test_reports.sql
-- ---------------------------------------------------------------------------
begin;

delete from public.reports where id::text like '7e57da7a%';

insert into public.reports
  (id, reporter_id, category, impacts, headline, description,
   lat, lng, address, city, country_code, happened_at, status)
values
  ('7e57da7a-0000-4000-8000-000000000001', null, 'pickpocket', array['money'],
   'Bag opened on the crowded lift queue',
   'Sample report — test data, not a real incident. Two people pressed in from either side while the queue shuffled forward. Bag was open and the wallet gone before the lift doors did.',
   48.8584, 2.2945, 'Champ de Mars', 'Paris', 'FR', now() - interval '31 hours', 'published'),

  ('7e57da7a-0000-4000-8000-000000000002', null, 'distraction', array[]::text[],
   'Bracelet tied on the wrist, then a price',
   'Sample report — test data, not a real incident. A friendly hand, a bracelet knotted on before you can pull away, then a price and a raised voice. Walking off worked; it was the scene they wanted.',
   48.8867, 2.3431, 'Place du Tertre, Montmartre', 'Paris', 'FR', now() - interval '3 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000003', null, 'pickpocket', array['money'],
   'Phone lifted off the cafe table on La Rambla',
   'Sample report — test data, not a real incident. A map was spread over the table to ask directions. The map went, and the phone under it went with it.',
   41.3809, 2.1730, 'La Rambla', 'Barcelona', 'ES', now() - interval '18 hours', 'published'),

  ('7e57da7a-0000-4000-8000-000000000004', null, 'tickets', array['money'],
   'Skip-the-line tickets that did not scan',
   'Sample report — test data, not a real incident. Bought from a man with a lanyard and a printed sign twenty metres from the gate. The barcode was refused at the turnstile and he was long gone.',
   41.8902, 12.4922, 'Piazza del Colosseo', 'Rome', 'IT', now() - interval '2 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000005', null, 'taxi', array['money'],
   'Meter off, fixed price quoted at the station',
   'Sample report — test data, not a real incident. The driver waved at a laminated card instead of the meter. The fare was roughly four times what the same trip cost back.',
   41.9010, 12.5020, 'Roma Termini', 'Rome', 'IT', now() - interval '5 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000006', null, 'overcharge', array['money'],
   'Two coffees and a bill for forty euros',
   'Sample report — test data, not a real incident. No prices on the menu, a cover charge per person and a service charge on top of that. Asking for the itemised bill got it halved.',
   45.4341, 12.3388, 'Piazza San Marco', 'Venice', 'IT', now() - interval '4 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000007', null, 'money', array['money'],
   'Change given in withdrawn currency',
   'Sample report — test data, not a real incident. The change came back in old notes no longer in circulation. The bank would not take them the next morning.',
   50.0865, 14.4114, 'Charles Bridge', 'Prague', 'CZ', now() - interval '6 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000008', null, 'distraction', array[]::text[],
   'Shell game with a crowd that was all in on it',
   'Sample report — test data, not a real incident. Every winner in the circle was part of it. The one stranger who played lost sixty euros in two minutes.',
   52.3731, 4.8926, 'Dam Square', 'Amsterdam', 'NL', now() - interval '20 hours', 'published'),

  ('7e57da7a-0000-4000-8000-000000000009', null, 'pickpocket', array['money'],
   'Worked the tram doors as it filled at the stop',
   'Sample report — test data, not a real incident. A blockage at the door, a push from behind, and a back pocket emptied in the crush. Front pockets and a hand on the bag from there on.',
   38.7139, -9.1334, 'Tram 28, Alfama', 'Lisbon', 'PT', now() - interval '2 days', 'published'),

  ('7e57da7a-0000-4000-8000-00000000000a', null, 'fake_official', array['threats'],
   'Fake officer demanding an on-the-spot fine',
   'Sample report — test data, not a real incident. Plain clothes, a laminated card flashed fast, and a demand for cash over a made-up document offence. Offering to walk to the station ended it.',
   52.5219, 13.4132, 'Alexanderplatz', 'Berlin', 'DE', now() - interval '3 days', 'published'),

  ('7e57da7a-0000-4000-8000-00000000000b', null, 'counterfeit', array['money'],
   'Show tickets sold outside that were not real',
   'Sample report — test data, not a real incident. Sold at face value outside the theatre with a plausible story about a friend cancelling. The box office had never issued them.',
   51.5103, -0.1300, 'Leicester Square', 'London', 'GB', now() - interval '5 days', 'published'),

  ('7e57da7a-0000-4000-8000-00000000000c', null, 'distraction', array['money'],
   'Guided the wrong way to a shop, then pressured',
   'Sample report — test data, not a real incident. Told the site was closed and walked to a carpet shop instead. It was not closed. Two hours to get back out of the shop politely.',
   41.0055, 28.9769, 'Sultanahmet Square', 'Istanbul', 'TR', now() - interval '26 hours', 'published'),

  ('7e57da7a-0000-4000-8000-00000000000d', null, 'overcharge', array['money'],
   'Henna and a photo, then a fee for both',
   'Sample report — test data, not a real incident. Started before anyone agreed to it, then a price per hand and per photo. Agree the number out loud first, or say no and keep walking.',
   31.6258, -7.9891, 'Jemaa el-Fnaa', 'Marrakesh', 'MA', now() - interval '4 days', 'published'),

  ('7e57da7a-0000-4000-8000-00000000000e', null, 'overcharge', array['money'],
   'Camel photo at the pyramids, then a fee to get down',
   'Sample report — test data, not a real incident. The ride up was the advertised price. Getting down again was another one, asked for once you were up there.',
   29.9773, 31.1325, 'Giza Plateau', 'Cairo', 'EG', now() - interval '6 days', 'published'),

  ('7e57da7a-0000-4000-8000-00000000000f', null, 'taxi', array['money'],
   'Tuk-tuk detour to a gem shop instead of the palace',
   'Sample report — test data, not a real incident. Told the palace was shut for a ceremony and taken to two shops on the way. The palace was open the whole time.',
   13.7500, 100.4913, 'Grand Palace', 'Bangkok', 'TH', now() - interval '22 hours', 'published'),

  ('7e57da7a-0000-4000-8000-000000000010', null, 'rental', array['money'],
   'Scooter hire charging for damage that was there',
   'Sample report — test data, not a real incident. Scratches already on it when it was collected. The deposit went on repairing them. Photograph everything before riding off.',
   -8.7180, 115.1686, 'Kuta Beach', 'Bali', 'ID', now() - interval '3 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000011', null, 'distraction', array['money'],
   'Free bracelet and a donation book',
   'Sample report — test data, not a real incident. A wristband pressed into the hand, then a clipboard with a list of large donations already written on it.',
   28.6315, 77.2167, 'Connaught Place', 'Delhi', 'IN', now() - interval '5 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000012', null, 'atm', array['money'],
   'Card skimmed at a machine in a side arcade',
   'Sample report — test data, not a real incident. Standalone machine off the main street, a loose card slot, and two withdrawals the next day from another country.',
   35.6595, 139.7005, 'Shibuya Crossing', 'Tokyo', 'JP', now() - interval '39 hours', 'published'),

  ('7e57da7a-0000-4000-8000-000000000013', null, 'counterfeit', array['money'],
   'CD pushed into your hands, then payment demanded',
   'Sample report — test data, not a real incident. Signed to you as a gift, then a price the moment you are holding it, with two more people arriving to agree that you owe it.',
   40.7580, -73.9855, 'Times Square', 'New York', 'US', now() - interval '2 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000014', null, 'money', array['money'],
   'Short-changed on a large note at a stall',
   'Sample report — test data, not a real incident. A large note handed over, change counted back for a smaller one, and an argument about which note it had been.',
   19.4326, -99.1332, 'Zocalo', 'Mexico City', 'MX', now() - interval '4 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000015', null, 'pickpocket', array['money'],
   'Bag taken from the chair back on the promenade',
   'Sample report — test data, not a real incident. Hung on the back of the chair for ten minutes at a beachfront cafe. Straps cut rather than lifted.',
   -22.9711, -43.1822, 'Copacabana', 'Rio de Janeiro', 'BR', now() - interval '28 hours', 'published'),

  ('7e57da7a-0000-4000-8000-000000000016', null, 'distraction', array['money'],
   'Something spilled on the jacket, then helpful hands',
   'Sample report — test data, not a real incident. A splash from nowhere, then two strangers very keen to help clean it off. The inside pocket was empty afterwards.',
   -34.6345, -58.3631, 'Caminito, La Boca', 'Buenos Aires', 'AR', now() - interval '6 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000017', null, 'taxi', array['money'],
   'Ride app cancelled, cash price doubled on arrival',
   'Sample report — test data, not a real incident. Driver asked to cancel in the app and pay cash instead, then named a different number at the destination.',
   -33.9036, 18.4204, 'V&A Waterfront', 'Cape Town', 'ZA', now() - interval '3 days', 'published'),

  ('7e57da7a-0000-4000-8000-000000000018', null, 'online', array['money'],
   'Apartment listing that did not exist',
   'Sample report — test data, not a real incident. Photographs lifted from a real listing elsewhere, a deposit asked for by bank transfer, and no address that matched anything.',
   -33.8610, 151.2100, 'Circular Quay', 'Sydney', 'AU', now() - interval '5 days', 'published');

commit;

-- What went in, and where.
select country_code, city, category,
       to_char(happened_at, 'YYYY-MM-DD HH24:MI') as happened
  from public.reports
 where id::text like '7e57da7a%'
 order by country_code, city;

select count(*) as test_reports_in_table
  from public.reports where id::text like '7e57da7a%';
