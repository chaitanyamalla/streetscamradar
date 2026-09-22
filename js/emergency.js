// ---------------------------------------------------------------------------
// Emergency numbers, by country.
//
// A traveller who has just been robbed should not have to search for the
// number. It changes as the map crosses a border, so it is always the number
// for the place being looked at, not the place the phone is in.
//
// This list is deliberately incomplete. A wrong emergency number is worse than
// no emergency number, so a country is only here if its numbers are
// well-established and published by its own emergency services. Anywhere else
// shows nothing rather than a guess.
//
// 112 reaches emergency services across the whole EU and EEA, and from a
// mobile in many countries beyond it; where a country also has its own
// numbers, both are shown, because the national ones are often answered
// faster and in the local language.
// ---------------------------------------------------------------------------

import { countryName, t } from './i18n.js';

/** general = one number for everything (or two, where both are official);
 *  the rest are service-specific. */
const NUMBERS = {
  // --- Europe --------------------------------------------------------------
  AT: { name: 'Austria',        general: '112', police: '133', fire: '122', ambulance: '144' },
  BE: { name: 'Belgium',        general: '112', police: '101' },
  BG: { name: 'Bulgaria',       general: '112' },
  HR: { name: 'Croatia',        general: '112' },
  CY: { name: 'Cyprus',         general: '112' },
  CZ: { name: 'Czechia',        general: '112', police: '158', fire: '150', ambulance: '155' },
  DK: { name: 'Denmark',        general: '112' },
  EE: { name: 'Estonia',        general: '112' },
  FI: { name: 'Finland',        general: '112' },
  FR: { name: 'France',         general: '112', police: '17',  fire: '18',  ambulance: '15' },
  DE: { name: 'Germany',        general: '112', police: '110', fire: '112', ambulance: '112' },
  GR: { name: 'Greece',         general: '112', police: '100', fire: '199', ambulance: '166' },
  HU: { name: 'Hungary',        general: '112', police: '107', fire: '105', ambulance: '104' },
  IS: { name: 'Iceland',        general: '112' },
  IE: { name: 'Ireland',        general: ['112', '999'] },
  IT: { name: 'Italy',          general: '112', police: '113', fire: '115', ambulance: '118' },
  LV: { name: 'Latvia',         general: '112' },
  LI: { name: 'Liechtenstein',  general: '112' },
  LT: { name: 'Lithuania',      general: '112' },
  LU: { name: 'Luxembourg',     general: '112', police: '113' },
  MT: { name: 'Malta',          general: '112' },
  MD: { name: 'Moldova',        general: '112' },
  ME: { name: 'Montenegro',     general: '112' },
  NL: { name: 'Netherlands',    general: '112' },
  MK: { name: 'North Macedonia', police: '192', fire: '193', ambulance: '194' },
  NO: { name: 'Norway',         police: '112', fire: '110', ambulance: '113' },
  PL: { name: 'Poland',         general: '112', police: '997', fire: '998', ambulance: '999' },
  PT: { name: 'Portugal',       general: '112' },
  RO: { name: 'Romania',        general: '112' },
  RS: { name: 'Serbia',         general: '112', police: '192', fire: '193', ambulance: '194' },
  SK: { name: 'Slovakia',       general: '112', police: '158', fire: '150', ambulance: '155' },
  SI: { name: 'Slovenia',       general: '112', police: '113' },
  ES: { name: 'Spain',          general: '112', police: '091', fire: '080', ambulance: '061' },
  SE: { name: 'Sweden',         general: '112' },
  CH: { name: 'Switzerland',    general: '112', police: '117', fire: '118', ambulance: '144' },
  TR: { name: 'Türkiye',        general: '112' },
  UA: { name: 'Ukraine',        general: '112', police: '102', fire: '101', ambulance: '103' },
  GB: { name: 'United Kingdom', general: ['999', '112'] },
  BA: { name: 'Bosnia and Herzegovina', police: '122', fire: '123', ambulance: '124' },
  AL: { name: 'Albania',        general: '112' },

  // --- Americas ------------------------------------------------------------
  US: { name: 'United States',  general: '911' },
  CA: { name: 'Canada',         general: '911' },
  MX: { name: 'Mexico',         general: '911' },
  AR: { name: 'Argentina',      general: '911', police: '101', fire: '100', ambulance: '107' },
  BR: { name: 'Brazil',         police: '190', fire: '193', ambulance: '192' },
  CL: { name: 'Chile',          police: '133', fire: '132', ambulance: '131' },
  CO: { name: 'Colombia',       general: '123' },
  PE: { name: 'Peru',           police: '105', fire: '116', ambulance: '106' },
  UY: { name: 'Uruguay',        general: '911', police: '911', fire: '104', ambulance: '105' },
  CR: { name: 'Costa Rica',     general: '911' },
  PA: { name: 'Panama',         police: '104', fire: '103', ambulance: '911' },

  // --- Asia & Pacific ------------------------------------------------------
  AU: { name: 'Australia',      general: '000' },
  NZ: { name: 'New Zealand',    general: '111' },
  JP: { name: 'Japan',          police: '110', fire: '119', ambulance: '119' },
  KR: { name: 'South Korea',    police: '112', fire: '119', ambulance: '119' },
  CN: { name: 'China',          police: '110', fire: '119', ambulance: '120' },
  HK: { name: 'Hong Kong',      general: '999' },
  TW: { name: 'Taiwan',         police: '110', fire: '119', ambulance: '119' },
  SG: { name: 'Singapore',      police: '999', fire: '995', ambulance: '995' },
  MY: { name: 'Malaysia',       general: '999' },
  TH: { name: 'Thailand',       police: '191', fire: '199', ambulance: '1669' },
  VN: { name: 'Vietnam',        police: '113', fire: '114', ambulance: '115' },
  ID: { name: 'Indonesia',      general: '112', police: '110', fire: '113' },
  PH: { name: 'Philippines',    general: '911' },
  IN: { name: 'India',          general: '112', police: '100', fire: '101', ambulance: '108' },
  PK: { name: 'Pakistan',       police: '15', fire: '16', ambulance: '1122' },
  BD: { name: 'Bangladesh',     general: '999' },
  LK: { name: 'Sri Lanka',      police: '119', fire: '110', ambulance: '1990' },
  NP: { name: 'Nepal',          police: '100', fire: '101', ambulance: '102' },
  AE: { name: 'United Arab Emirates', police: '999', fire: '997', ambulance: '998' },
  SA: { name: 'Saudi Arabia',   general: '911', police: '999', fire: '998', ambulance: '997' },
  QA: { name: 'Qatar',          general: '999' },
  IL: { name: 'Israel',         police: '100', fire: '102', ambulance: '101' },

  // --- Africa --------------------------------------------------------------
  EG: { name: 'Egypt',          police: '122', fire: '180', ambulance: '123' },
  MA: { name: 'Morocco',        police: '19', fire: '15', ambulance: '15' },
  ZA: { name: 'South Africa',   general: '112', police: '10111', ambulance: '10177' },
  KE: { name: 'Kenya',          general: '999', police: '112' },
  NG: { name: 'Nigeria',        general: '112' },
  GH: { name: 'Ghana',          police: '191', fire: '192', ambulance: '193' },
  TZ: { name: 'Tanzania',       general: '112' },
};

/**
 * What to show for a country, or null if we do not know it well enough to say.
 * Returns the numbers already ordered for display, most useful first.
 */
export function emergencyFor(countryCode) {
  const entry = NUMBERS[(countryCode ?? '').toUpperCase()];
  if (!entry) return null;

  // One entry per distinct number, labelled with everything it reaches. Japan
  // answers fire and ambulance on 119, and in Germany 112 is the general
  // number, the fire number and the ambulance number — listing the same digits
  // under three headings is noise, not information.
  const byNumber = new Map();
  const add = (label, number) => {
    if (!number) return;
    const labels = byNumber.get(number) ?? [];
    if (!labels.includes(label)) labels.push(label);
    byNumber.set(number, labels);
  };

  // Where two numbers both reach everything — 999 and 112 in the UK and
  // Ireland — the second reads as an alternative rather than a second heading.
  [entry.general ?? []].flat()
    .forEach((number, i) => add(i ? 'emergency.or' : 'emergency.all', number));
  add('emergency.police', entry.police);
  add('emergency.fire', entry.fire);
  add('emergency.ambulance', entry.ambulance);

  const numbers = [...byNumber].map(([number, keys]) => ({
    number,
    // "All services" already covers everything, so it never needs company.
    label: keys.includes('emergency.all')
      ? t('emergency.all')
      : keys.map(k => t(k)).join(' & '),
  }));
  // The English name in the table is the last resort: every browser can say
  // "Deutschland" or "Niemcy" from the ISO code, and says it better than a
  // list we would have to keep in seven languages.
  const code = (countryCode ?? '').toUpperCase();
  return { name: countryName(code, entry.name), numbers };
}

export const knownCountries = () => Object.keys(NUMBERS).length;
