// Generate app/lib/countryMeta.ts from the caps map: display names worth putting
// on screen (Natural Earth ships "Dem. Rep. Congo", "United States of America",
// "Br. Indian Ocean Ter.") plus a continent bucket the picker can group by.
//
// Natural Earth's continent field is unreliable for island states — Seychelles,
// Mauritius and Maldives all land in "Seven seas (open ocean)" — so those get
// corrected here rather than shipped to the UI.
//
// Usage:  node scripts/build-country-meta.mjs
// Input:  public/country-caps.geojson
// Gate:   node scripts/map-layers-check.mjs (asserts full coverage both ways)
import { readFileSync, writeFileSync } from "node:fs";

const CAPS = "public/country-caps.geojson";

const REGIONS = ["Africa", "Americas", "Asia", "Europe", "Oceania", "Polar & Remote"];

// Natural Earth continent -> our bucket.
const REGION_OF = {
  Africa: "Africa",
  "North America": "Americas",
  "South America": "Americas",
  Asia: "Asia",
  Europe: "Europe",
  Oceania: "Oceania",
  Antarctica: "Polar & Remote",
  "Seven seas (open ocean)": "Polar & Remote",
};
// ...except these, which are plainly not "Polar & Remote".
const REGION_OVERRIDE = { MV: "Asia", MU: "Africa", SC: "Africa" };

// Abbreviations and legacy names -> what we actually print.
const NAME_OVERRIDE = {
  AQ: "Antarctica",
  AX: "Åland Islands",
  AG: "Antigua & Barbuda",
  BD: "Bangladesh",
  BO: "Bolivia",
  BA: "Bosnia & Herzegovina",
  VG: "British Virgin Islands",
  IO: "British Indian Ocean Territory",
  KH: "Cambodia",
  CF: "Central African Republic",
  KY: "Cayman Islands",
  TD: "Chad",
  CN: "China",
  CX: "Christmas Island",
  CC: "Cocos Islands",
  CD: "DR Congo",
  DK: "Denmark",
  DJ: "Djibouti",
  DM: "Dominica",
  DO: "Dominican Republic",
  EG: "Egypt",
  GQ: "Equatorial Guinea",
  ER: "Eritrea",
  SZ: "Eswatini",
  FK: "Falkland Islands",
  FO: "Faroe Islands",
  PF: "French Polynesia",
  TF: "French Southern Territories",
  GA: "Gabon",
  GM: "Gambia",
  GS: "South Georgia & the Sandwich Is.",
  HN: "Honduras",
  HM: "Heard & McDonald Islands",
  VA: "Vatican City",
  HK: "Hong Kong",
  IN: "India",
  CI: "Côte d'Ivoire",
  HT: "Haiti",
  IQ: "Iraq",
  IE: "Ireland",
  IM: "Isle of Man",
  IL: "Israel",
  JM: "Jamaica",
  JP: "Japan",
  JE: "Jersey",
  JO: "Jordan",
  KZ: "Kazakhstan",
  KE: "Kenya",
  KP: "North Korea",
  KR: "South Korea",
  KW: "Kuwait",
  KG: "Kyrgyzstan",
  LA: "Laos",
  LV: "Latvia",
  LS: "Lesotho",
  LR: "Liberia",
  LY: "Libya",
  LI: "Liechtenstein",
  LT: "Lithuania",
  MO: "Macao",
  MG: "Madagascar",
  MW: "Malawi",
  MY: "Malaysia",
  MV: "Maldives",
  ML: "Mali",
  MH: "Marshall Islands",
  MQ: "Martinique",
  MU: "Mauritius",
  MX: "Mexico",
  FM: "Micronesia",
  MD: "Moldova",
  MC: "Monaco",
  MN: "Mongolia",
  ME: "Montenegro",
  MS: "Montserrat",
  MM: "Myanmar",
  NA: "Namibia",
  NR: "Nauru",
  NL: "Netherlands",
  NZ: "New Zealand",
  NI: "Nicaragua",
  NE: "Niger",
  NG: "Nigeria",
  NU: "Niue",
  NF: "Norfolk Island",
  MK: "North Macedonia",
  MP: "Northern Mariana Islands",
  NO: "Norway",
  OM: "Oman",
  PK: "Pakistan",
  PW: "Palau",
  PS: "Palestine",
  PA: "Panama",
  PG: "Papua New Guinea",
  PY: "Paraguay",
  PE: "Peru",
  PH: "Philippines",
  PN: "Pitcairn Islands",
  PL: "Poland",
  PR: "Puerto Rico",
  QA: "Qatar",
  RE: "Réunion",
  RO: "Romania",
  RU: "Russia",
  BL: "St. Barthélemy",
  SH: "Saint Helena",
  KN: "St. Kitts & Nevis",
  LC: "Saint Lucia",
  MF: "St. Martin",
  PM: "St. Pierre & Miquelon",
  VC: "St. Vincent & the Grenadines",
  WS: "Samoa",
  SM: "San Marino",
  ST: "São Tomé & Príncipe",
  SN: "Senegal",
  RS: "Serbia",
  SC: "Seychelles",
  SL: "Sierra Leone",
  SG: "Singapore",
  SX: "Sint Maarten",
  SB: "Solomon Islands",
  SO: "Somalia",
  ZA: "South Africa",
  SS: "South Sudan",
  ES: "Spain",
  LK: "Sri Lanka",
  SD: "Sudan",
  SR: "Suriname",
  SJ: "Svalbard & Jan Mayen",
  SE: "Sweden",
  CH: "Switzerland",
  SY: "Syria",
  TW: "Taiwan",
  TJ: "Tajikistan",
  TZ: "Tanzania",
  TH: "Thailand",
  TL: "Timor-Leste",
  TG: "Togo",
  TK: "Tokelau",
  TO: "Tonga",
  TT: "Trinidad & Tobago",
  TN: "Tunisia",
  TR: "Türkiye",
  TM: "Turkmenistan",
  TC: "Turks & Caicos Islands",
  TV: "Tuvalu",
  UG: "Uganda",
  UA: "Ukraine",
  AE: "United Arab Emirates",
  GB: "United Kingdom",
  US: "United States",
  UY: "Uruguay",
  UZ: "Uzbekistan",
  VU: "Vanuatu",
  VE: "Venezuela",
  VN: "Vietnam",
  WF: "Wallis & Futuna",
  EH: "Western Sahara",
  YE: "Yemen",
  ZM: "Zambia",
  ZW: "Zimbabwe",
};

const caps = JSON.parse(readFileSync(CAPS, "utf8"));

const rows = [];
for (const f of caps.features) {
  const p = f.properties;
  const iso = p.ISO_A2;
  const region = REGION_OVERRIDE[iso] ?? REGION_OF[p.CONTINENT];
  if (!region) throw new Error(`no region for ${iso} (${p.NAME}, continent=${p.CONTINENT})`);
  rows.push({ iso, name: NAME_OVERRIDE[iso] ?? p.NAME, region });
}
rows.sort((a, b) => a.iso.localeCompare(b.iso));

const body = rows
  .map((r) => `  ${r.iso}: { name: ${JSON.stringify(r.name)}, region: "${r.region}" },`)
  .join("\n");

writeFileSync(
  "app/lib/countryMeta.ts",
  `// GENERATED by scripts/build-country-meta.mjs — do not edit by hand.
// Run \`node scripts/build-country-meta.mjs\` after regenerating the caps map.
// Source: public/country-caps.geojson (Natural Earth names/continents, corrected).

export type Region = "Africa" | "Americas" | "Asia" | "Europe" | "Oceania" | "Polar & Remote";

/** Display order for the region rail and the picker's group headers. */
export const REGIONS: Region[] = ${JSON.stringify(REGIONS)};

export interface CountryMeta {
  /** Human-facing name. Never Natural Earth's abbreviated form. */
  name: string;
  region: Region;
}

export const COUNTRY_META: Record<string, CountryMeta> = {
${body}
};

export function countryName(iso: string): string | null {
  return COUNTRY_META[iso]?.name ?? null;
}

export function countryRegion(iso: string): Region | null {
  return COUNTRY_META[iso]?.region ?? null;
}
`
);

console.log(`wrote app/lib/countryMeta.ts (${rows.length} countries)`);
