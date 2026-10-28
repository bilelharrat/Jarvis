// Entry rules Eden Travel can state for a trip (papers.js): passport validity and travel authorisations, each one read
// on the government's own site, kept here as data with its address, the words it was taken from and the day it was
// last verified. Nothing else is a rule: a destination or a nationality not listed here gets "check the official page"
// with the link (entry.js), never a guess. When a site changes, change the row and its `verified`.
//
// Read 2026-10-28 (by Eden's build, on the official pages below):
//   Schengen: europa.eu Your Europe "Travel documents for non-EU nationals" (page "Last checked: 19/08/2026").
//   UK: gov.uk/standard-visitor (passport valid for the whole stay); gov.uk/eta and gov.uk/eta/apply (decision,
//     how long it lasts); Immigration Rules Appendix ETA National List (who needs one).
//   US: dhs.gov/visa-waiver-program (the 42 countries, "Last Updated: 10/28/2026"); dhs.gov/visa-waiver-program-
//     requirements (e-passport); esta.cbp.dhs.gov/faq (when to apply, valid only on arrival). The FAQ no longer says
//     "72 hours": DHS recommends applying "when travel plans are made".
//   Canada: canada.ca entry-requirements-country (eTA-required list), eta/eligibility (air only, US exemptions),
//     eta/about ("best to get an eTA before you book your travel").
//   Australia: immi.homeaffairs.gov.au ETA (601) and eVisitor (651) pages, "Have an eligible passport" lists.
//   New Zealand: immigration.govt.nz visa-waiver-countries-and-territories (NZeTA needed before you arrive).
//   ETIAS: travel-europe.europa.eu/en/etias: "ETIAS is currently not in operation and no applications for travel
//     authorisations are collected at this point." So Eden says it hasn't started, and asks for nothing.

export const RULES_VERIFIED = '2026-10-28';

// the 29 countries of the Schengen area, as Your Europe lists them (Cyprus and Ireland are not in it)
export const SCHENGEN = ['AT', 'BE', 'BG', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'CH'];
// EU member states (the Schengen rule above is written for "a national from a country outside the EU")
export const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
// Iceland, Liechtenstein, Norway, Switzerland: Your Europe's sentence names non-EU nationals only, and Eden has no
// checked page saying how it applies to them, so for these (as for EU citizens) Eden states no passport rule.
const NO_RULE_FOR = new Set([...EU, 'IS', 'LI', 'NO', 'CH']);

const YOUR_EUROPE = 'https://europa.eu/youreurope/citizens/travel/entry-exit/non-eu-nationals/index_en.htm';

/**
 * Passport validity. `until`: 'leave' (valid for the whole stay) or 'leave+3m' (3 months after you leave the area);
 * `issued_years`: issued within this many years on the day you enter. `for(nationality)` → true when the rule is
 * written for that traveller, false when it is not (no rule stated then).
 */
export const PASSPORT_RULES = [
  {
    id: 'schengen-passport', area: 'Schengen area', countries: SCHENGEN, until: 'leave+3m', issued_years: 10,
    for: (nat) => !NO_RULE_FOR.has(nat),
    source: { by: 'European Commission (Your Europe)', url: YOUR_EUROPE, verified: '2026-10-28',
      quote: 'Your passport should be valid for at least 3 months after the date you intend to leave the EU and it must have been issued within the last 10 years.' },
  },
  {
    id: 'uk-passport', area: 'United Kingdom', countries: ['GB'], until: 'leave', issued_years: null,
    for: (nat) => nat !== 'GB' && nat !== 'IE', // British citizens are not visitors; Irish citizens: Eden has no checked page
    source: { by: 'GOV.UK (Standard Visitor)', url: 'https://www.gov.uk/standard-visitor', verified: '2026-10-28',
      quote: 'You must have a passport or travel document to enter the UK. It should be valid for the whole of your stay.' },
  },
];

// ISO 3166-1 alpha-2 for each official list, in the list's own order where it had one
const VWP = ['AD', 'AU', 'AT', 'BE', 'BN', 'CL', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IL', 'IT', 'JP', 'KR', 'LV', 'LI', 'LT', 'LU', 'MT', 'MC', 'NL', 'NZ', 'NO', 'PL', 'PT', 'QA', 'SM', 'SG', 'SK', 'SI', 'ES', 'SE', 'CH', 'TW', 'GB'];
const CA_ETA = ['AD', 'AU', 'AT', 'BS', 'BB', 'BE', 'GB', 'AI', 'BM', 'VG', 'KY', 'FK', 'GI', 'MS', 'PN', 'SH', 'TC', 'BN', 'BG', 'CL', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HK', 'HU', 'IS', 'IE', 'IL', 'IT', 'JP', 'LV', 'LI', 'LT', 'LU', 'MT', 'MC', 'NL', 'NZ', 'NO', 'PG', 'PL', 'PT', 'QA', 'KR', 'RO', 'WS', 'SM', 'SG', 'SK', 'SI', 'SB', 'ES', 'SE', 'CH', 'TW', 'AE', 'VA'];
const UK_ETA = ['QA', 'BH', 'KW', 'OM', 'AE', 'SA', 'AG', 'AR', 'AU', 'BB', 'BZ', 'BR', 'BN', 'CA', 'CL', 'CR', 'GD', 'GT', 'GY', 'HK', 'IL', 'JP', 'KI', 'MO', 'MY', 'MV', 'MH', 'MU', 'MX', 'FM', 'NZ', 'PW', 'PA', 'PG', 'PY', 'PE', 'KN', 'VC', 'WS', 'SC', 'SG', 'SB', 'KR', 'TW', 'BS', 'TO', 'TV', 'US', 'UY', 'AD', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'MC', 'NL', 'NO', 'PL', 'PT', 'RO', 'SM', 'SK', 'SI', 'ES', 'SE', 'CH', 'VA'];
const AU_ETA = ['AD', 'AT', 'BE', 'BN', 'CA', 'DK', 'FI', 'FR', 'DE', 'GR', 'HK', 'IS', 'IE', 'IT', 'JP', 'LI', 'LU', 'MY', 'MT', 'MC', 'NO', 'PT', 'SM', 'SG', 'KR', 'ES', 'SE', 'CH', 'TW', 'NL', 'GB', 'US', 'VA'];
const AU_EVISITOR = ['AD', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'MC', 'NL', 'NO', 'PL', 'PT', 'RO', 'SM', 'SK', 'SI', 'ES', 'SE', 'CH', 'GB', 'VA'];
const NZ_WAIVER = ['AD', 'AR', 'AT', 'BH', 'BE', 'BR', 'BN', 'BG', 'CA', 'CL', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HK', 'HU', 'IS', 'IE', 'IL', 'IT', 'JP', 'KR', 'KW', 'LV', 'LI', 'LT', 'LU', 'MO', 'MY', 'MT', 'MU', 'MX', 'MC', 'NL', 'NO', 'OM', 'PL', 'PT', 'QA', 'RO', 'SM', 'SA', 'SC', 'SG', 'SK', 'SI', 'ES', 'SE', 'CH', 'TW', 'AE', 'GB', 'US', 'UY', 'VA'];

/**
 * Travel authorisations. A traveller needs one going to `country` when their nationality is in `needed_by` and not in
 * `exempt`. Any other nationality (except the country's own) gets "check the official page": it may need a visa,
 * or nothing, and Eden doesn't say which.
 *   apply: { working_days } (apply at least this many working days before you arrive), { before_booking: true }
 *          (the site says to get it before booking), { before_arrival: true } (must have it before you arrive), or
 *          { when_planned: true } (apply when travel plans are made). `text` is the site's advice in short.
 *   valid_on: 'arrival' when the site says it only has to be valid on arrival; null when it doesn't say (then Eden
 *          flags one that ends during the stay as "check").
 *   caveat: the list's own conditions, shown with the item.
 */
export const AUTH_RULES = [
  {
    id: 'us-esta', kind: 'esta', name: 'ESTA', country: 'US', needed_by: VWP, exempt: [],
    apply: { when_planned: true, text: 'Homeland Security recommends applying when travel plans are made.' },
    valid_on: 'arrival', apply_url: 'https://esta.cbp.dhs.gov/',
    caveat: 'Visa Waiver Program: an e-passport is needed; for the UK, British citizens only; Taiwan and the Netherlands have conditions on the official page.',
    source: { by: 'U.S. Department of Homeland Security', url: 'https://www.dhs.gov/visa-waiver-program', verified: '2026-10-28',
      also: ['https://esta.cbp.dhs.gov/faq', 'https://www.dhs.gov/visa-waiver-program-requirements'],
      quote: 'ESTA travel authorization needs only to be valid upon arrival in the United States.' },
  },
  {
    id: 'ca-eta', kind: 'eta_ca', name: 'Canada eTA', country: 'CA', needed_by: CA_ETA, exempt: ['US'], air_only: true,
    apply: { before_booking: true, text: 'Canada.ca: it’s best to get an eTA before you book your travel.' },
    valid_on: null, apply_url: 'https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/eta.html',
    caveat: 'Only when flying in; arriving by car, bus, train or boat usually needs only a valid passport. Romania: e-passports only.',
    source: { by: 'Government of Canada (IRCC)', url: 'https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/entry-requirements-country.html', verified: '2026-10-28',
      also: ['https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/eta/eligibility.html', 'https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/eta/about.html'],
      quote: 'You need an eTA and a valid passport to board your flight to Canada if you’re a citizen of any of the countries or territories listed below.' },
  },
  {
    id: 'uk-eta', kind: 'eta_uk', name: 'UK ETA', country: 'GB', needed_by: UK_ETA, exempt: ['GB', 'IE'],
    apply: { working_days: 3, text: 'GOV.UK: a decision usually comes within a day, but it can take up to 3 working days.' },
    valid_on: null, apply_url: 'https://www.gov.uk/eta/apply',
    caveat: 'Not needed with permission to live, work or study in the UK. Each traveller needs their own, babies too.',
    source: { by: 'GOV.UK (Home Office)', url: 'https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-eta-national-list', verified: '2026-10-28',
      also: ['https://www.gov.uk/eta', 'https://www.gov.uk/eta/apply'],
      quote: 'An ETA lasts for 2 years or until your passport expires, whichever is sooner.' },
  },
  {
    id: 'au-eta', kind: 'eta_au', name: 'Australia ETA or eVisitor', country: 'AU', needed_by: [...new Set([...AU_ETA, ...AU_EVISITOR])], exempt: ['AU'],
    apply: { before_booking: true, text: 'Home Affairs suggests you don’t make travel arrangements until it’s granted.' },
    valid_on: null, apply_url: 'https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/electronic-travel-authority-601',
    caveat: 'Your passport decides which: the ETA (subclass 601, through the Australian ETA app) or the eVisitor (subclass 651); some passports can use either.',
    source: { by: 'Australian Department of Home Affairs', url: 'https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/electronic-travel-authority-601', verified: '2026-10-28',
      also: ['https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-listing/evisitor-651'],
      quote: 'You must hold a valid passport from one of these countries or jurisdictions to be eligible for an ETA.' },
  },
  {
    id: 'nz-eta', kind: 'nzeta', name: 'NZeTA', country: 'NZ', needed_by: NZ_WAIVER, exempt: ['AU', 'NZ'],
    apply: { before_arrival: true, text: 'Immigration New Zealand: you must have it before you arrive.' },
    valid_on: null, apply_url: 'https://www.immigration.govt.nz/visit/what-you-need-to-visit-new-zealand/visa-waiver-countries-and-territories/',
    caveat: 'Some entries have conditions on the official list (Hong Kong, Macau, Taiwan, Portugal, Greece, the Baltic states).',
    source: { by: 'Immigration New Zealand', url: 'https://www.immigration.govt.nz/visit/what-you-need-to-visit-new-zealand/visa-waiver-countries-and-territories/', verified: '2026-10-28',
      quote: 'If you need an NZeTA, you must have it before you arrive in New Zealand.' },
  },
];

/** ETIAS: not started, per its official site. Eden shows this, and never asks anyone to apply for it. */
export const ETIAS = {
  started: false, countries: SCHENGEN, // its site says "30 European countries"; Eden shows the note for the Schengen ones only
  text: 'ETIAS hasn’t started: no applications are taken yet. The EU says it will announce the start date several months ahead.',
  source: { by: 'European Union (official ETIAS site)', url: 'https://travel-europe.europa.eu/en/etias', verified: '2026-10-28',
    quote: 'ETIAS is currently not in operation and no applications for travel authorisations are collected at this point.' },
};

/** The kinds a traveller can save an approval for (papers.js), and what they're called. */
export const AUTH_KINDS = Object.fromEntries(AUTH_RULES.map((r) => [r.kind, { name: r.name, country: r.country }]));

export const passportRulesFor = (cc) => PASSPORT_RULES.filter((r) => r.countries.includes(cc));
export const authRuleFor = (cc) => AUTH_RULES.find((r) => r.country === cc) || null;
