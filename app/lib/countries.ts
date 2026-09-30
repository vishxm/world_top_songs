// Countries with a dedicated YouTube Music chart (from the live
// FEmusic_charts country menu: 69 countries + Global). Any other
// selection falls back to the Global chart.

export const CHART_COUNTRIES: Record<string, string> = {
  AR: "Argentina",
  AU: "Australia",
  AT: "Austria",
  BE: "Belgium",
  BO: "Bolivia",
  BR: "Brazil",
  CA: "Canada",
  CL: "Chile",
  CO: "Colombia",
  CR: "Costa Rica",
  CZ: "Czechia",
  DK: "Denmark",
  DO: "Dominican Republic",
  EC: "Ecuador",
  EG: "Egypt",
  SV: "El Salvador",
  EE: "Estonia",
  FI: "Finland",
  FR: "France",
  DE: "Germany",
  GT: "Guatemala",
  HN: "Honduras",
  HK: "Hong Kong",
  HU: "Hungary",
  IS: "Iceland",
  IN: "India",
  ID: "Indonesia",
  IE: "Ireland",
  IL: "Israel",
  IT: "Italy",
  JP: "Japan",
  KE: "Kenya",
  LU: "Luxembourg",
  MY: "Malaysia",
  MX: "Mexico",
  NL: "Netherlands",
  NZ: "New Zealand",
  NI: "Nicaragua",
  NG: "Nigeria",
  NO: "Norway",
  PA: "Panama",
  PY: "Paraguay",
  PE: "Peru",
  PH: "Philippines",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  RU: "Russia",
  SA: "Saudi Arabia",
  RS: "Serbia",
  SG: "Singapore",
  ZA: "South Africa",
  KR: "South Korea",
  ES: "Spain",
  SE: "Sweden",
  CH: "Switzerland",
  TW: "Taiwan",
  TZ: "Tanzania",
  TH: "Thailand",
  TR: "Turkey",
  UG: "Uganda",
  UA: "Ukraine",
  AE: "United Arab Emirates",
  GB: "United Kingdom",
  US: "United States",
  UY: "Uruguay",
  VN: "Vietnam",
  ZW: "Zimbabwe",
};

export function isChartCountry(iso: string): boolean {
  return iso in CHART_COUNTRIES;
}

export function flagEmoji(iso: string): string {
  if (!/^[A-Z]{2}$/.test(iso)) return "🌐";
  const base = 0x1f1e6;
  return String.fromCodePoint(
    ...iso.split("").map((c) => base + c.charCodeAt(0) - 65)
  );
}
