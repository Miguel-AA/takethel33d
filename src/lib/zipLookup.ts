// Resolves a US city from a 5-digit ZIP code for the /events lead form.
//
// Uses the free, key-less, CORS-enabled Zippopotam.us public API
// (https://api.zippopotam.us/us/<zip>). No npm dependency is added — this uses
// the platform `fetch`. Works for any US ZIP, including all Florida ZIPs.
//
// Contract: returns the resolved city, or null when it cannot be determined
// (bad ZIP, network error, or unknown ZIP). The form never blocks on this and
// the City field stays manually editable.
//
// TODO(zip-to-city): if an offline/bundled dataset is preferred over a network
// call (e.g. for reliability without internet), swap this implementation for a
// local ZIP→city table; the (zip) => Promise<string|null> contract stays the same.
interface ZippopotamResponse {
  places?: Array<{ 'place name'?: string }>;
}

export async function lookupCityByZip(zip: string): Promise<string | null> {
  const clean = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(clean)) return null;
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${clean}`);
    if (!res.ok) return null;
    const data = (await res.json()) as ZippopotamResponse;
    const city = data.places?.[0]?.['place name'];
    return typeof city === 'string' && city.trim().length > 0 ? city.trim() : null;
  } catch {
    return null;
  }
}
