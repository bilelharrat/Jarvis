// Entry and travel advice for a destination: LINKS to the official government page, never the
// rules themselves. Visa and entry rules change and depend on the person; Eden doesn't state
// them, it points to the page that does.
//
// Only pages whose address was confirmed are listed; any other country gets null, not a guessed
// address. Checked 2026-10-27:
//   UK (FCDO): https://www.gov.uk/foreign-travel-advice/<slug>. Slugs from GOV.UK's own index,
//     https://www.gov.uk/api/content/foreign-travel-advice (226 pages); portugal and japan fetched (200).
//   US (State Department): https://travel.state.gov/en/international-travel/travel-advisories/<slug>.html,
//     one page per country with the advisory and the entry, exit and visa requirements. The old
//     .../International-Travel-Country-Information-Pages/<Name>.html pages 301 there since 2026.
//     travel.state.gov now answers scripts with a Cloudflare check, so each slug here was confirmed
//     by an Internet Archive capture of that exact address answering 200 (2025-12 on).
//     Countries without such a capture are left out until someone confirms them.

const NOTE = 'Official page: check entry rules and visas there before you go';
export const VERIFIED_ON = '2026-10-27';

// ISO 3166-1 alpha-2 → travel.state.gov slug
const US_SLUG = {
  AD: 'andorra', AF: 'afghanistan', AO: 'angola', AQ: 'antarctica', BD: 'bangladesh', BF: 'burkina-faso',
  BG: 'bulgaria', BH: 'bahrain', BJ: 'benin', BN: 'brunei', BO: 'bolivia', BW: 'botswana', BY: 'belarus',
  BZ: 'belize', CA: 'canada', CF: 'central-african-republic', CH: 'switzerland', CI: 'cote-d-ivoire', CL: 'chile',
  CM: 'cameroon', CN: 'china', CO: 'colombia', CR: 'costa-rica', CV: 'cabo-verde', CZ: 'czechia', DE: 'germany',
  DO: 'dominican-republic', EC: 'ecuador', EG: 'egypt', ES: 'spain', FI: 'finland', FR: 'france', GA: 'gabon',
  GB: 'united-kingdom', GH: 'ghana', GM: 'the-gambia', GN: 'guinea', GQ: 'equatorial-guinea', GR: 'greece',
  GT: 'guatemala', GW: 'guinea-bissau', HR: 'croatia', HU: 'hungary', ID: 'indonesia', IE: 'ireland', IN: 'india',
  IR: 'iran', IS: 'iceland', IT: 'italy', JM: 'jamaica', JO: 'jordan', JP: 'japan', KG: 'the-kyrgyz-republic',
  KH: 'cambodia', KM: 'comoros', KP: 'north-korea', KR: 'south-korea', KY: 'cayman-islands', LB: 'lebanon',
  LI: 'liechtenstein', LK: 'sri-lanka', LR: 'liberia', LU: 'luxembourg', MD: 'moldova', MG: 'madagascar',
  MH: 'marshall-islands', ML: 'mali', MM: 'burma', MU: 'mauritius', MV: 'maldives', MW: 'malawi', MX: 'mexico',
  MY: 'malaysia', NA: 'namibia', NE: 'niger', NG: 'nigeria', NI: 'nicaragua', NP: 'nepal', NZ: 'new-zealand',
  OM: 'oman', PK: 'pakistan', PT: 'portugal', PW: 'palau', RO: 'romania', RU: 'russia', RW: 'rwanda',
  SA: 'saudi-arabia', SC: 'seychelles', SD: 'sudan', SE: 'sweden', SG: 'singapore', SI: 'slovenia', SK: 'slovakia',
  SL: 'sierra-leone', SN: 'senegal', SO: 'somalia', SS: 'south-sudan', ST: 'sao-tome-and-principe',
  SV: 'el-salvador', SY: 'syria', TD: 'chad', TL: 'timor-leste', TN: 'tunisia', TR: 'turkey',
  TT: 'trinidad-and-tobago', UG: 'uganda', UZ: 'uzbekistan', VE: 'venezuela', VN: 'vietnam', WS: 'samoa',
  YE: 'yemen', ZA: 'south-africa',
};

// ISO 3166-1 alpha-2 → gov.uk/foreign-travel-advice slug (a few slugs cover several territories)
const UK_SLUG = {
  AD: 'andorra', AE: 'united-arab-emirates', AF: 'afghanistan', AG: 'antigua-and-barbuda', AI: 'anguilla',
  AL: 'albania', AM: 'armenia', AO: 'angola', AQ: 'antarctica-british-antarctic-territory', AR: 'argentina',
  AT: 'austria', AU: 'australia', AW: 'aruba', AZ: 'azerbaijan', BA: 'bosnia-and-herzegovina', BB: 'barbados',
  BD: 'bangladesh', BE: 'belgium', BF: 'burkina-faso', BG: 'bulgaria', BH: 'bahrain', BI: 'burundi', BJ: 'benin',
  BL: 'st-martin-and-st-barthelemy', BM: 'bermuda', BN: 'brunei', BO: 'bolivia', BQ: 'bonaire-st-eustatius-saba',
  BR: 'brazil', BS: 'bahamas', BT: 'bhutan', BW: 'botswana', BY: 'belarus', BZ: 'belize', CA: 'canada',
  CD: 'democratic-republic-of-the-congo', CF: 'central-african-republic', CG: 'congo', CH: 'switzerland',
  CI: 'cote-d-ivoire', CK: 'cook-islands-tokelau-and-niue', CL: 'chile', CM: 'cameroon', CN: 'china', CO: 'colombia',
  CR: 'costa-rica', CU: 'cuba', CV: 'cape-verde', CW: 'curacao', CY: 'cyprus', CZ: 'czechia', DE: 'germany',
  DJ: 'djibouti', DK: 'denmark', DM: 'dominica', DO: 'dominican-republic', DZ: 'algeria', EC: 'ecuador',
  EE: 'estonia', EG: 'egypt', EH: 'western-sahara', ER: 'eritrea', ES: 'spain', ET: 'ethiopia', FI: 'finland',
  FJ: 'fiji', FK: 'falkland-islands', FM: 'federated-states-of-micronesia', FR: 'france', GA: 'gabon', GD: 'grenada',
  GE: 'georgia', GF: 'french-guiana', GH: 'ghana', GI: 'gibraltar', GM: 'the-gambia', GN: 'guinea', GP: 'guadeloupe',
  GQ: 'equatorial-guinea', GR: 'greece', GS: 'south-georgia-and-south-sandwich-islands', GT: 'guatemala',
  GW: 'guinea-bissau', GY: 'guyana', HK: 'hong-kong', HN: 'honduras', HR: 'croatia', HT: 'haiti', HU: 'hungary',
  ID: 'indonesia', IE: 'ireland', IL: 'israel', IN: 'india', IO: 'british-indian-ocean-territory', IQ: 'iraq',
  IR: 'iran', IS: 'iceland', IT: 'italy', JM: 'jamaica', JO: 'jordan', JP: 'japan', KE: 'kenya', KG: 'kyrgyzstan',
  KH: 'cambodia', KI: 'kiribati', KM: 'comoros', KN: 'st-kitts-and-nevis', KP: 'north-korea', KR: 'south-korea',
  KW: 'kuwait', KY: 'cayman-islands', KZ: 'kazakhstan', LA: 'laos', LB: 'lebanon', LC: 'st-lucia',
  LI: 'liechtenstein', LK: 'sri-lanka', LR: 'liberia', LS: 'lesotho', LT: 'lithuania', LU: 'luxembourg',
  LV: 'latvia', LY: 'libya', MA: 'morocco', MC: 'monaco', MD: 'moldova', ME: 'montenegro',
  MF: 'st-martin-and-st-barthelemy', MG: 'madagascar', MH: 'marshall-islands', MK: 'north-macedonia', ML: 'mali',
  MM: 'myanmar', MN: 'mongolia', MO: 'macao', MQ: 'martinique', MR: 'mauritania', MS: 'montserrat', MT: 'malta',
  MU: 'mauritius', MV: 'maldives', MW: 'malawi', MX: 'mexico', MY: 'malaysia', MZ: 'mozambique', NA: 'namibia',
  NC: 'new-caledonia', NE: 'niger', NG: 'nigeria', NI: 'nicaragua', NL: 'netherlands', NO: 'norway', NP: 'nepal',
  NR: 'nauru', NU: 'cook-islands-tokelau-and-niue', NZ: 'new-zealand', OM: 'oman', PA: 'panama', PE: 'peru',
  PF: 'french-polynesia', PG: 'papua-new-guinea', PH: 'philippines', PK: 'pakistan', PL: 'poland',
  PM: 'st-pierre-and-miquelon', PN: 'pitcairn-island', PS: 'palestine', PT: 'portugal', PW: 'palau', PY: 'paraguay',
  QA: 'qatar', RE: 'reunion', RO: 'romania', RS: 'serbia', RU: 'russia', RW: 'rwanda', SA: 'saudi-arabia',
  SB: 'solomon-islands', SC: 'seychelles', SD: 'sudan', SE: 'sweden', SG: 'singapore',
  SH: 'st-helena-ascension-and-tristan-da-cunha', SI: 'slovenia', SK: 'slovakia', SL: 'sierra-leone',
  SM: 'san-marino', SN: 'senegal', SO: 'somalia', SR: 'suriname', SS: 'south-sudan', ST: 'sao-tome-and-principe',
  SV: 'el-salvador', SX: 'st-maarten', SY: 'syria', SZ: 'eswatini', TC: 'turks-and-caicos-islands', TD: 'chad',
  TG: 'togo', TH: 'thailand', TJ: 'tajikistan', TK: 'cook-islands-tokelau-and-niue', TL: 'timor-leste',
  TM: 'turkmenistan', TN: 'tunisia', TO: 'tonga', TR: 'turkey', TT: 'trinidad-and-tobago', TV: 'tuvalu',
  TW: 'taiwan', TZ: 'tanzania', UA: 'ukraine', UG: 'uganda', US: 'usa', UY: 'uruguay', UZ: 'uzbekistan',
  VC: 'st-vincent-and-the-grenadines', VE: 'venezuela', VG: 'british-virgin-islands', VN: 'vietnam', VU: 'vanuatu',
  WF: 'wallis-and-futuna', WS: 'samoa', XK: 'kosovo', YE: 'yemen', YT: 'mayotte', ZA: 'south-africa', ZM: 'zambia',
  ZW: 'zimbabwe',
};

const BY = {
  US: { by: 'U.S. Department of State', slug: US_SLUG, url: (s) => `https://travel.state.gov/en/international-travel/travel-advisories/${s}.html`, title: (n) => `${n} Travel Advisory` },
  GB: { by: 'UK Foreign, Commonwealth & Development Office', slug: UK_SLUG, url: (s) => `https://www.gov.uk/foreign-travel-advice/${s}`, title: (n) => `${n} travel advice` },
};
const PASSPORT = { US: 'US', USA: 'US', GB: 'GB', UK: 'GB', GBR: 'GB' };

let names;
const nameOf = (code) => {
  try {
    names ||= new Intl.DisplayNames(['en'], { type: 'region' });
    return names.of(code) || code;
  } catch {
    return code;
  }
};

/** entryAdvice({ country_code, passport }) → [{ title, url, by, note, country_code, passport, verified_on }] or null.
 *  passport 'US' or 'GB' gives that government's page; no passport gives every official page Eden has. */
export function entryAdvice({ country_code, passport } = {}) {
  const cc = String(country_code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  let govs;
  if (passport == null || passport === '') govs = Object.keys(BY);
  else {
    const p = PASSPORT[String(passport).trim().toUpperCase()];
    if (!p) return null; // no confirmed official page for that passport's government yet
    govs = [p];
  }
  const out = govs
    .filter((g) => BY[g].slug[cc])
    .map((g) => ({ title: BY[g].title(nameOf(cc)), url: BY[g].url(BY[g].slug[cc]), by: BY[g].by, note: NOTE, country_code: cc, passport: g, verified_on: VERIFIED_ON }));
  return out.length ? out : null;
}

export const ENTRY_COUNTRIES = { US: Object.keys(US_SLUG), GB: Object.keys(UK_SLUG) };
