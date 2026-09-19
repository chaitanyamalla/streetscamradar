-- ---------------------------------------------------------------------------
-- Demo data: scam reports across a handful of world cities, so the map has
-- something to show before real members arrive.
--
-- Every row here has reporter_id = NULL, which a genuine report can never
-- have (the insert policy forces reporter_id = auth.uid()). That makes demo
-- data trivially separable — supabase/ops/seed_demo_remove.sql deletes exactly
-- these and nothing a real person wrote.
--
-- happened_at is spread over the last six days so everything falls inside the
-- 7-day visibility window. Re-running this adds duplicates; remove first.
-- ---------------------------------------------------------------------------

-- The proof-of-access table has done its job.
drop table if exists public.claude_access_check;

insert into public.reports
  (reporter_id, category, severity, headline, description, lat, lng, address, city, country_code, happened_at, support_count)
values
-- Paris -----------------------------------------------------------------
(null,'pickpocket','high','Team working the doors on Metro line 1','Three people crowded the doorway at Louvre-Rivoli just as the doors closed. One blocked me, another opened the outer pocket of my backpack. Keep bags in front on that line.',48.8606,2.3376,'Louvre-Rivoli station','Paris','FR', now() - interval '5 hours', 4),
(null,'distraction','medium','Bracelet tied on wrist by Sacre-Coeur steps','A man took my wrist and knotted a string bracelet before I could pull away, then demanded twenty euros loudly until I paid. Keep hands in pockets walking up the steps.',48.8867,2.3431,'Steps below Sacre-Coeur','Paris','FR', now() - interval '2 days', 6),
(null,'tickets','medium','Museum queue-jump passes sold outside','Someone in a hi-vis vest sold us skip-the-line tickets for the Louvre that turned out to be ordinary printed paper. Staff said they see it daily.',48.8606,2.3376,'Outside the Louvre pyramid','Paris','FR', now() - interval '3 days', 2),

-- Barcelona -------------------------------------------------------------
(null,'pickpocket','high','Phone lifted from table on La Rambla terrace','A folded map was laid over my phone on the cafe table while someone asked directions. Map and phone both gone in seconds. Do not put a phone on the table there.',41.3809,2.1735,'La Rambla','Barcelona','ES', now() - interval '8 hours', 9),
(null,'fake_official','high','Two men in plain clothes claiming to be drug police','They showed a laminated card, asked to inspect my wallet for counterfeit notes, and counted my cash. Two hundred euros missing afterwards. Real police never check your wallet in the street.',41.3851,2.1734,'Near Placa de Catalunya','Barcelona','ES', now() - interval '1 day', 7),
(null,'overcharge','medium','Menu prices doubled on the bill near the beach','Prices on the printed menu were not the prices charged. When questioned they produced a second menu. Photograph the menu before ordering.',41.3784,2.1925,'Barceloneta seafront','Barcelona','ES', now() - interval '4 days', 1),

-- Rome ------------------------------------------------------------------
(null,'taxi','high','Airport taxi refused the meter and charged 140 EUR','Driver quoted a flat fare, refused to start the meter and would not take card. The official fixed fare from Fiumicino is posted at the rank.',41.8003,12.2389,'Fiumicino arrivals','Rome','IT', now() - interval '18 hours', 5),
(null,'distraction','medium','Football thrown at tourists by the Colosseum','A ball is kicked at you, someone apologises and dusts you off, and your pockets are emptied while they do. Walk on if a ball comes your way.',41.8902,12.4922,'Colosseum forecourt','Rome','IT', now() - interval '3 days', 3),
(null,'counterfeit','low','Fake designer bags sold near the Spanish Steps','Sellers claim outlet stock. Buying counterfeits is itself a fine in Italy, so walking away is the cheap option.',41.9058,12.4823,'Spanish Steps','Rome','IT', now() - interval '5 days', 0),

-- Prague ----------------------------------------------------------------
(null,'money','high','Exchange booth kept 30 percent as a hidden fee','The sign advertised zero commission. The rate applied was nothing like the board rate and the difference was called a service charge. Use a bank or an ATM inside one.',50.0870,14.4207,'Old Town Square','Prague','CZ', now() - interval '1 day', 8),
(null,'taxi','medium','Driver claimed the card machine was broken','Then drove to an ATM and waited beside me while I withdrew cash. Order a car through an app instead of taking one from the rank.',50.0755,14.4378,'Wenceslas Square','Prague','CZ', now() - interval '4 days', 2),

-- Lisbon ----------------------------------------------------------------
(null,'pickpocket','medium','Crowded tram 28 worked by a pair','One stood on the step blocking the aisle while the other went through a backpack behind. Busiest between Baixa and Graca.',38.7139,-9.1334,'Tram 28','Lisbon','PT', now() - interval '2 days', 4),
(null,'other','low','Substances offered loudly in Baixa at night','Persistent approaches near the main square. Nothing sold is what it claims to be, and the sellers work in pairs.',38.7101,-9.1390,'Baixa','Lisbon','PT', now() - interval '6 days', 1),

-- Istanbul --------------------------------------------------------------
(null,'overcharge','high','Invited to a bar, presented with a 400 EUR bill','A friendly local suggested a drink nearby. Two beers and the bill arrived with charges for company we never asked for. Do not follow strangers to a bar.',41.0369,28.9850,'Off Istiklal Avenue','Istanbul','TR', now() - interval '20 hours', 11),
(null,'other','medium','Shoeshine brush dropped deliberately in front of me','I picked it up and handed it back, then was given a shine I did not ask for and charged heavily. Walk past a dropped brush.',41.0082,28.9784,'Near Galata Bridge','Istanbul','TR', now() - interval '3 days', 3),

-- Bangkok ---------------------------------------------------------------
(null,'tickets','high','Told the Grand Palace was closed for a ceremony','A well-dressed man outside said it was shut and arranged a tuk-tuk tour of gem shops instead. The palace was open. It is never closed to tourists.',13.7500,100.4913,'Grand Palace entrance','Bangkok','TH', now() - interval '12 hours', 6),
(null,'taxi','medium','Tuk-tuk 20 baht tour ends at a tailor shop','The cheap fare is real, but the route is a series of shops where the driver earns commission. Expect an hour of hard selling.',13.7563,100.5018,'Khao San Road','Bangkok','TH', now() - interval '2 days', 2),

-- Delhi -----------------------------------------------------------------
(null,'fake_official','high','Fake tourist office redirected us from the station','A man outside New Delhi station said our hotel booking was cancelled and took us to an office that sold an expensive tour. The station has one official booking counter, upstairs.',28.6430,77.2197,'New Delhi railway station','Delhi','IN', now() - interval '1 day', 9),
(null,'taxi','medium','Driver insisted our destination was closed','Standard approach: the market is shut, the road is blocked, let me take you elsewhere. Insist on the original destination or get out.',28.6139,77.2090,'Connaught Place','Delhi','IN', now() - interval '4 days', 3),

-- New York --------------------------------------------------------------
(null,'other','medium','CD handed over then payment demanded in Times Square','A disc is pressed into your hands as a gift, then a signature and a donation are demanded aggressively. Do not accept anything handed to you there.',40.7580,-73.9855,'Times Square','New York','US', now() - interval '2 days', 5),
(null,'tickets','low','Bus tour tickets sold at double the gate price','Sellers in branded jackets who are not affiliated with the operator. Buy from the kiosk or the operator app.',40.7580,-73.9855,'42nd Street','New York','US', now() - interval '5 days', 1),

-- Mexico City -----------------------------------------------------------
(null,'atm','high','Card skimmer on a street ATM in Centro','The card slot was loose and a thin panel sat above the keypad. Two charges appeared the next morning. Use ATMs inside bank branches.',19.4326,-99.1332,'Centro Historico','Mexico City','MX', now() - interval '16 hours', 7),
(null,'taxi','medium','Street taxi took a long route and demanded cash','Flagged from the street rather than a rank. Use an app or an authorised sitio rank.',19.4270,-99.1676,'Zona Rosa','Mexico City','MX', now() - interval '3 days', 2),

-- Berlin ----------------------------------------------------------------
(null,'rental','high','Deposit requested for a flat that did not exist','The listing asked for a transfer before any viewing, with a plausible story about being abroad. Never transfer money before seeing a place in person.',52.4819,13.4311,'Neukoelln','Berlin','DE', now() - interval '1 day', 8),
(null,'pickpocket','medium','Bag opened at Warschauer Strasse platform','Two people created a bottleneck at the stairs while a third worked behind. Busiest on Friday evenings.',52.5054,13.4504,'Warschauer Strasse','Berlin','DE', now() - interval '6 days', 3);

-- What went in.
select 'SEEDED' as step, count(*) as demo_reports, count(distinct city) as cities
  from public.reports where reporter_id is null;

select city, country_code, count(*) as reports,
       count(*) filter (where severity = 'high') as high
  from public.reports where reporter_id is null
 group by city, country_code order by reports desc, city;

select 'sample table gone' as step,
       not exists (select 1 from information_schema.tables
                    where table_schema='public' and table_name='claude_access_check') as confirmed;
