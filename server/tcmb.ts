// Exchange rates from the Central Bank of the Republic of Turkey (TCMB). Each business day at 15:30 TCMB publishes
// the day's indicative rates at <base>/YYYYMM/DDMMYYYY.xml; weekends and holidays have no file (404). The rates are
// kept by the day they were announced, and the days without a file are remembered, so a rate is fetched once.
//
// Which day's rate a receipt uses is set in the file: `previous` (the default) takes the rates announced on the last
// business day before the receipt's date, which are the ones in force that day; `same` takes the ones announced on its
// date, or before it when that day had none.
import { LinkError } from "./links.ts";
import { rateMicro } from "./money.ts";
import { addDays, type Store } from "./store.ts";
import type { RateKind } from "./config.ts";

export type Rates = Record<RateKind, number | null>;

const FIELDS: Array<[RateKind, string]> = [
  ["forex_buying", "ForexBuying"],
  ["forex_selling", "ForexSelling"],
  ["banknote_buying", "BanknoteBuying"],
  ["banknote_selling", "BanknoteSelling"],
];

/** The currencies in one of TCMB's files, each per one unit of the currency in millionths of a lira. */
export function parseTcmb(xml: string): { day: string; rates: Map<string, Rates> } | null {
  const date = /<Tarih_Date[^>]*\sTarih="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  if (!date) return null;
  const rates = new Map<string, Rates>();
  for (const m of xml.matchAll(/<Currency\b[^>]*\sCurrencyCode="([A-Z]{3})"[^>]*>([\s\S]*?)<\/Currency>/g)) {
    const inner = m[2]!;
    const tag = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(inner)?.[1] ?? "";
    const unit = Number(tag("Unit") || "1");
    const r = {} as Rates;
    for (const [k, name] of FIELDS) r[k] = tag(name) ? rateMicro(tag(name), unit) : null;
    if (FIELDS.some(([k]) => r[k] !== null)) rates.set(m[1]!, r);
  }
  return { day: `${date[3]}-${date[2]}-${date[1]}`, rates };
}

export const tcmbUrl = (base: string, day: string) =>
  `${base}/${day.slice(0, 4)}${day.slice(5, 7)}/${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(0, 4)}.xml`;

/** The day's rates, or "none" when TCMB published nothing that day. */
export async function fetchTcmbDay(f: typeof fetch, base: string, day: string): Promise<{ day: string; rates: Map<string, Rates> } | "none"> {
  let res: Response;
  try {
    res = await f(tcmbUrl(base, day), { headers: { accept: "application/xml, text/xml" }, signal: AbortSignal.timeout(8000), redirect: "follow" });
  } catch (err) {
    throw new LinkError(`TCMB could not be reached: ${(err as Error).message}`);
  }
  if (res.status === 404) return "none";
  if (!res.ok) throw new LinkError(`TCMB answered ${res.status}`, res.status);
  const parsed = parseTcmb(await res.text());
  if (!parsed) throw new LinkError("TCMB's file could not be read as its rates.");
  if (parsed.day !== day) return "none";
  return parsed;
}

export interface RateAnswer {
  /** Millionths of a lira for one unit of the currency. */
  micro: number;
  /** The day TCMB announced it. */
  day: string;
}

/** Looks up and keeps TCMB's rates. `today` is the install's local day. */
export function createRateBook(store: Store, opts: { fetch?: typeof fetch }) {
  const f = opts.fetch ?? fetch;
  const { one, run, tx, iso } = store;

  function keep(day: string, rates: Map<string, Rates>) {
    tx(() => {
      for (const [cur, r] of rates)
        run(
          "INSERT OR REPLACE INTO rates (day, currency, forex_buying, forex_selling, banknote_buying, banknote_selling) VALUES (?, ?, ?, ?, ?, ?)",
          day,
          cur,
          r.forex_buying,
          r.forex_selling,
          r.banknote_buying,
          r.banknote_selling,
        );
      run("INSERT OR REPLACE INTO rate_days (day, published, fetched_at) VALUES (?, 1, ?)", day, iso());
    });
  }

  /**
   * The rate for a receipt in `currency` dated `date`, with `kind` and `which` from the file. Looks back up to 15 days
   * for a business day. Throws a LinkError when TCMB cannot be reached, and a plain Error when TCMB has no such rate.
   */
  async function rateFor(currency: string, date: string, kind: RateKind, which: "previous" | "same", base: string, today: string): Promise<RateAnswer> {
    let d = which === "previous" ? addDays(date, -1) : date;
    if (d > today) d = today;
    for (let i = 0; i < 15; i++, d = addDays(d, -1)) {
      const known = one<{ published: number }>("SELECT published FROM rate_days WHERE day = ?", d);
      if (known && !known.published) continue;
      if (!known) {
        const got = await fetchTcmbDay(f, base, d);
        if (got === "none") {
          // Today's file comes at 15:30: until then, today is not yet a day without rates.
          if (d < today) run("INSERT OR REPLACE INTO rate_days (day, published, fetched_at) VALUES (?, 0, ?)", d, iso());
          continue;
        }
        keep(d, got.rates);
      }
      const row = one<Record<RateKind, number | null>>(`SELECT ${kind} FROM rates WHERE day = ? AND currency = ?`, d, currency);
      if (!row || row[kind] === null) {
        // TCMB lists some currencies with only some of the four rates.
        throw new Error(`TCMB publishes no ${kind.replace("_", " ")} rate for ${currency}.`);
      }
      return { micro: row[kind]!, day: d };
    }
    throw new Error(`TCMB published no rates in the 15 days before ${date}.`);
  }

  /** The currencies TCMB published on the last day it is known to have, for the settings and the policy. */
  const known = (): string[] =>
    store
      .q<{ currency: string }>("SELECT currency FROM rates WHERE day = (SELECT MAX(day) FROM rate_days WHERE published = 1) ORDER BY currency")
      .map((r) => r.currency);

  return { rateFor, known };
}
export type RateBook = ReturnType<typeof createRateBook>;
