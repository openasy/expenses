// Expenses' settings, from one YAML file (EXPENSES_CONFIG): the categories with their limits, KDV and account codes,
// mileage and daily allowance rates, the approval chains by amount and department, receipts and the service that reads
// them, the currencies and which TCMB rate converts them, company card statements, exports, the people and projects
// used when HR and Time are not linked, and the links to them. As in the other products, the file is the only way in:
// no screen or API route changes these. It is applied whole or not at all, read again within a minute of a change, and
// a file with a mistake leaves the last good version in place. Claims, receipts and everything done on them are kept in
// the database.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { knownCurrency, parseFileAmount } from "./money.ts";

export type CategoryKind = "receipt" | "mileage" | "per_diem";
export type OverLimit = "flag" | "block" | "cap";

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  /** The accountant's account code, written in the export, such as 770.01. */
  account: string | null;
  /** The KDV rate a TRY receipt in it carries unless the person says otherwise; null for none. */
  kdv: number | null;
  /** Limits in kuruş, per person: one item, one day, one month. */
  limits: { perItem: number | null; perDay: number | null; perMonth: number | null };
  /** What an amount over a limit does: flag it for finance, refuse the claim, or pay back only up to the limit. */
  overLimit: OverLimit;
  project: "required" | "optional" | "none";
  /** Mileage: kuruş per kilometre. */
  perKm: number | null;
  /** Daily allowance: a rate per day by country code (TR, DE), with "default" for the rest. */
  perDay: Record<string, { amount: number; currency: string }> | null;
}

export interface Step {
  /** manager: the person's manager (from HR or the file); finance: any editor; or one member, by email. */
  approver: "manager" | "finance" | string;
  /** The step applies only when the claim's total is over this, in kuruş; 0 for always. */
  over: number;
}

export interface Person {
  email: string;
  name: string | null;
  employeeId: string | null;
  department: string | null;
  manager: string | null;
}

export type RateKind = "forex_buying" | "forex_selling" | "banknote_buying" | "banknote_selling";

export interface Config {
  timeZone: string;
  /** Currencies receipts may be in, other than TRY; null for every currency TCMB publishes. */
  currencies: string[] | null;
  rates: { url: string; kind: RateKind; day: "previous" | "same" };
  receipts: {
    maxSize: number;
    types: string[];
    /** Receipts dated longer ago than this many days are flagged; null for never. */
    maxAgeDays: number | null;
    reader: { url: string; token: string | null; minConfidence: number } | null;
  };
  kdvRates: number[];
  categories: Category[];
  approvals: { chain: Step[]; departments: Record<string, Step[]> };
  departments: Array<{ id: string; name: string }>;
  people: Person[];
  projects: Array<{ id: string; name: string }>;
  cards: {
    columns: Record<CardColumn, string[]>;
    /** The last four digits of a card, and whose it is. */
    holders: Record<string, string>;
    matchDays: number;
    /** How the statement writes a purchase: as a positive amount (most banks) or a negative one. */
    purchases: "positive" | "negative";
  };
  exports: { separator: ";" | "," | "\t"; decimal: "," | "." };
  hr: { url: string; token: string; everyMinutes: number } | null;
  time: { url: string; token: string; everyMinutes: number } | null;
}

export type CardColumn = "date" | "description" | "amount" | "card" | "currency" | "original_amount" | "holder";

export const TYPES: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
};

const CARD_COLUMNS: Record<CardColumn, string[]> = {
  date: ["İşlem Tarihi", "Tarih", "Date", "Transaction date"],
  description: ["Açıklama", "İşlem Açıklaması", "İşlem", "Description", "Merchant"],
  amount: ["Tutar", "Tutar (TL)", "TL Tutar", "İşlem Tutarı", "Amount"],
  card: ["Kart No", "Kart Numarası", "Kart", "Card", "Card number"],
  currency: ["Para Birimi", "Döviz Cinsi", "Currency"],
  original_amount: ["Orijinal Tutar", "Döviz Tutarı", "Original amount"],
  holder: ["Kart Sahibi", "E-posta", "Holder", "Email"],
};

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOP = [
  "time_zone",
  "currencies",
  "rates",
  "receipts",
  "kdv_rates",
  "categories",
  "approvals",
  "departments",
  "people",
  "projects",
  "cards",
  "exports",
  "hr",
  "time",
];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if ((typeof v !== "string" && typeof v !== "number") || !String(v).trim() || String(v).length > max)
    throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return String(v).trim();
}

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as EXPENSES_HR_TOKEN, never the secret itself.`);
  return v;
}

function percent(v: unknown, at: string): number {
  const m = typeof v === "number" ? [String(v), String(v)] : /^(\d+(?:\.\d{1,2})?)\s*%$/.exec(String(v ?? "").trim());
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= 0 && n <= 100)) throw new Error(`${at} is a rate from 0% to 100%, such as 20%.`);
  return n;
}

/** A TRY amount in the file, in kuruş. */
function lira(v: unknown, at: string): number {
  const a = parseFileAmount(v);
  if (!a || a.currency !== "TRY" || a.amount < 0) throw new Error(`${at} is an amount in TRY, such as 5000 or 5000.50.`);
  return a.amount;
}

function days(v: unknown, at: string, min: number, max: number): number {
  const m = /^(\d{1,4})\s*d$/.exec(String(v ?? "").trim());
  const n = m ? Number(m[1]) : typeof v === "number" && Number.isInteger(v) ? v : NaN;
  if (!(n >= min && n <= max)) throw new Error(`${at} is ${min}d to ${max}d.`);
  return n;
}

function size(v: unknown, at: string): number {
  const m = /^(\d{1,4})\s*(KB|MB)$/i.exec(String(v ?? "").trim());
  if (!m) throw new Error(`${at} is a size such as 10MB or 512KB.`);
  const n = Number(m[1]) * (m[2]!.toUpperCase() === "MB" ? 1024 * 1024 : 1024);
  if (n < 16 * 1024 || n > 25 * 1024 * 1024) throw new Error(`${at} is 16KB to 25MB.`);
  return n;
}

/** An address of another product: https://, or http:// inside the install (localhost, or a host without dots). */
function baseUrl(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const inside = url && (/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || !url.hostname.includes("."));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && inside)) || url.search || url.hash)
    throw new Error(`${at} is an https:// address, such as https://hr.example.com (http:// only for a host without dots, such as http://hr:8080).`);
  return url.origin + url.pathname.replace(/\/$/, "");
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function email(v: unknown, at: string): string {
  if (typeof v !== "string" || !EMAIL.test(v.trim()) || v.length > 254) throw new Error(`${at} is an email address.`);
  return v.trim().toLowerCase();
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_CATEGORIES: Category[] = [
  {
    id: "travel",
    name: "Travel",
    kind: "receipt",
    account: null,
    kdv: 20,
    limits: { perItem: null, perDay: null, perMonth: null },
    overLimit: "flag",
    project: "optional",
    perKm: null,
    perDay: null,
  },
  {
    id: "meals",
    name: "Meals",
    kind: "receipt",
    account: null,
    kdv: 10,
    limits: { perItem: null, perDay: null, perMonth: null },
    overLimit: "flag",
    project: "optional",
    perKm: null,
    perDay: null,
  },
  {
    id: "other",
    name: "Other",
    kind: "receipt",
    account: null,
    kdv: 20,
    limits: { perItem: null, perDay: null, perMonth: null },
    overLimit: "flag",
    project: "optional",
    perKm: null,
    perDay: null,
  },
];

function stepsOf(v: unknown, at: string): Step[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 10)
    throw new Error(`${at} is a list of 1 to 10 steps, such as [manager, { approver: finance, over: 10000 }].`);
  const steps = v.map((s, i): Step => {
    const sat = `${at}[${i}]`;
    const o: Record<string, unknown> = isObj(s) ? s : { approver: s };
    keys(o, sat, ["approver", "over"]);
    const who = typeof o.approver === "string" ? o.approver.trim() : "";
    const approver = who === "manager" || who === "finance" ? who : EMAIL.test(who) ? who.toLowerCase() : null;
    if (!approver) throw new Error(`${sat}.approver is manager, finance or a member's email.`);
    return { approver, over: o.over === undefined ? 0 : lira(o.over, `${sat}.over`) };
  });
  return steps;
}

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const timeZone = doc.time_zone === undefined ? "Europe/Istanbul" : text(doc.time_zone, "time_zone", 64);
  if (!validTimeZone(timeZone)) throw new Error(`time_zone: ${timeZone} is not a time zone, such as Europe/Istanbul.`);

  // Currencies and the rate that turns them into TRY.
  let currencies: string[] | null = null;
  if (doc.currencies !== undefined && doc.currencies !== null && doc.currencies !== "all") {
    if (!Array.isArray(doc.currencies) || doc.currencies.length > 60) throw new Error("currencies is all, or a list of codes such as [EUR, USD].");
    currencies = [
      ...new Set(
        doc.currencies.map((c, i) => {
          const code = String(c).trim().toUpperCase();
          if (!knownCurrency(code)) throw new Error(`currencies[${i}]: ${code} is not an ISO 4217 currency code.`);
          return code;
        }),
      ),
    ].filter((c) => c !== "TRY");
  }
  const rt = doc.rates ?? {};
  if (!isObj(rt)) throw new Error("rates is a map with url, use and day.");
  keys(rt, "rates", ["url", "use", "day"]);
  const kind = rt.use ?? "forex_buying";
  if (!["forex_buying", "forex_selling", "banknote_buying", "banknote_selling"].includes(kind as string))
    throw new Error("rates.use is forex_buying (döviz alış), forex_selling, banknote_buying or banknote_selling.");
  const rateDay = rt.day ?? "previous";
  if (rateDay !== "previous" && rateDay !== "same")
    throw new Error("rates.day is previous (the rates TCMB announced the business day before the receipt) or same (on its day).");
  const rates = {
    url: rt.url === undefined ? "https://www.tcmb.gov.tr/kurlar" : baseUrl(rt.url, "rates.url"),
    kind: kind as RateKind,
    day: rateDay as "previous" | "same",
  };

  // Receipts.
  const rc = doc.receipts ?? {};
  if (!isObj(rc)) throw new Error("receipts is a map with max_size, types, max_age and reader.");
  keys(rc, "receipts", ["max_size", "types", "max_age", "reader"]);
  const typeNames = rc.types ?? ["jpeg", "png", "webp", "heic", "pdf"];
  if (!Array.isArray(typeNames) || !typeNames.length) throw new Error(`receipts.types is a list of ${Object.keys(TYPES).join(", ")}.`);
  const types = [
    ...new Set(
      typeNames.map((t, i) => {
        const mime = TYPES[String(t).trim().toLowerCase()];
        if (!mime) throw new Error(`receipts.types[${i}]: ${String(t)} is not one of ${Object.keys(TYPES).join(", ")}.`);
        return mime;
      }),
    ),
  ];
  let reader: Config["receipts"]["reader"] = null;
  if (rc.reader !== undefined && rc.reader !== null) {
    const r = rc.reader;
    if (!isObj(r)) throw new Error("receipts.reader is a map with url, token and min_confidence.");
    keys(r, "receipts.reader", ["url", "token", "min_confidence"]);
    reader = {
      url: baseUrl(r.url, "receipts.reader.url"),
      token: r.token === undefined || r.token === null ? null : env(r.token, "receipts.reader.token"),
      minConfidence: r.min_confidence === undefined ? 0.8 : Number(r.min_confidence),
    };
    if (!(reader.minConfidence >= 0 && reader.minConfidence <= 1)) throw new Error("receipts.reader.min_confidence is 0 to 1, such as 0.8.");
  }
  const receipts = {
    maxSize: rc.max_size === undefined ? 10 * 1024 * 1024 : size(rc.max_size, "receipts.max_size"),
    types,
    maxAgeDays: rc.max_age === undefined ? 90 : rc.max_age === null || rc.max_age === "never" ? null : days(rc.max_age, "receipts.max_age", 1, 3650),
    reader,
  };

  const kdvRates =
    doc.kdv_rates === undefined
      ? [0, 1, 10, 20]
      : Array.isArray(doc.kdv_rates) && doc.kdv_rates.length && doc.kdv_rates.length <= 10
        ? [...new Set(doc.kdv_rates.map((r, i) => percent(r, `kdv_rates[${i}]`)))].sort((a, b) => a - b)
        : (() => {
            throw new Error("kdv_rates is a list of the KDV rates receipts may carry, such as [0%, 1%, 10%, 20%].");
          })();

  // Categories.
  const categories: Category[] = [];
  const cs = doc.categories ?? null;
  if (cs === null) categories.push(...DEFAULT_CATEGORIES);
  else {
    if (!isObj(cs) || Object.keys(cs).length < 1 || Object.keys(cs).length > 60)
      throw new Error("categories is a map of 1 to 60 categories, such as meals: { name, limit }.");
    for (const [id, v] of Object.entries(cs)) {
      const at = `categories.${id}`;
      if (!ID.test(id)) throw new Error(`${at}: a category id is up to 32 lowercase letters, digits and -.`);
      const c = v === null ? {} : v;
      if (!isObj(c)) throw new Error(`${at} is a map with name, kind, account, kdv, limit, over_limit, project and rate.`);
      keys(c, at, ["name", "kind", "account", "kdv", "limit", "over_limit", "project", "rate", "rates"]);
      const kindOf = c.kind ?? "receipt";
      if (kindOf !== "receipt" && kindOf !== "mileage" && kindOf !== "per_diem") throw new Error(`${at}.kind is receipt, mileage or per_diem.`);
      const lm = c.limit ?? {};
      if (!isObj(lm)) throw new Error(`${at}.limit is a map with per_item, per_day and per_month, in TRY.`);
      keys(lm, `${at}.limit`, ["per_item", "per_day", "per_month"]);
      const lim = (k: string) => (lm[k] === undefined || lm[k] === null ? null : lira(lm[k], `${at}.limit.${k}`));
      const overLimit = c.over_limit ?? "flag";
      if (overLimit !== "flag" && overLimit !== "block" && overLimit !== "cap")
        throw new Error(`${at}.over_limit is flag (finance approves it), block (the claim cannot be sent) or cap (paid back up to the limit).`);
      const project = c.project ?? "optional";
      if (project !== "required" && project !== "optional" && project !== "none") throw new Error(`${at}.project is required, optional or none.`);
      let perKm: number | null = null;
      let perDay: Category["perDay"] = null;
      if (kindOf === "mileage") {
        if (c.rate === undefined) throw new Error(`${at}.rate is the amount paid per kilometre, in TRY, such as 8.50.`);
        perKm = lira(c.rate, `${at}.rate`);
        if (perKm < 1) throw new Error(`${at}.rate is more than 0.`);
        if (c.rates !== undefined) throw new Error(`${at}: rates is for per_diem; mileage takes rate.`);
      } else if (kindOf === "per_diem") {
        const rs = c.rates;
        if (!isObj(rs) || !Object.keys(rs).length || Object.keys(rs).length > 250)
          throw new Error(`${at}.rates is a map of country codes to a day's allowance, such as { TR: 600, DE: 60 EUR, default: 50 EUR }.`);
        perDay = {};
        for (const [country, r] of Object.entries(rs)) {
          const cat = `${at}.rates.${country}`;
          if (country !== "default" && !/^[A-Z]{2}$/.test(country)) throw new Error(`${cat}: a country is a two-letter code such as DE, or default.`);
          const a = parseFileAmount(r);
          if (!a || a.amount < 1 || !knownCurrency(a.currency)) throw new Error(`${cat} is an amount and currency, such as 600 or 60 EUR.`);
          perDay[country] = a;
        }
        if (c.rate !== undefined) throw new Error(`${at}: rate is for mileage; per_diem takes rates.`);
      } else if (c.rate !== undefined || c.rates !== undefined) throw new Error(`${at}: rate and rates are for mileage and per_diem categories.`);
      const kdv = c.kdv === undefined ? (kindOf === "receipt" ? 20 : null) : c.kdv === null || c.kdv === "none" ? null : percent(c.kdv, `${at}.kdv`);
      if (kdv !== null && kindOf !== "receipt") throw new Error(`${at}.kdv: mileage and daily allowances carry no KDV.`);
      if (kdv !== null && !kdvRates.includes(kdv)) throw new Error(`${at}.kdv: ${kdv}% is not in kdv_rates.`);
      categories.push({
        id,
        name: c.name === undefined ? id.charAt(0).toUpperCase() + id.slice(1) : text(c.name, `${at}.name`, 60),
        kind: kindOf,
        account: c.account === undefined || c.account === null ? null : text(c.account, `${at}.account`, 40),
        kdv,
        limits: { perItem: lim("per_item"), perDay: lim("per_day"), perMonth: lim("per_month") },
        overLimit,
        project,
        perKm,
        perDay,
      });
    }
  }

  // Departments, and people for when HR is not linked.
  const departments: Config["departments"] = [];
  const ds = doc.departments ?? {};
  if (!isObj(ds) || Object.keys(ds).length > 200) throw new Error("departments is a map of up to 200 department ids to names, such as sales: Sales.");
  for (const [id, v] of Object.entries(ds)) {
    if (!ID.test(id)) throw new Error(`departments.${id}: a department id is up to 32 lowercase letters, digits and -.`);
    if (isObj(v)) keys(v, `departments.${id}`, ["name"]);
    const name = v === null ? id : isObj(v) ? (v.name === undefined ? id : text(v.name, `departments.${id}.name`, 60)) : text(v, `departments.${id}`, 60);
    departments.push({ id, name });
  }

  const people: Person[] = [];
  const ps = doc.people ?? {};
  if (!isObj(ps) || Object.keys(ps).length > 5000) throw new Error("people is a map of emails to { name, department, manager, employee_id }.");
  for (const [who, v] of Object.entries(ps)) {
    const at = `people.${who}`;
    const e = email(who, at);
    const p = v ?? {};
    if (!isObj(p)) throw new Error(`${at} is a map with name, department, manager and employee_id.`);
    keys(p, at, ["name", "department", "manager", "employee_id"]);
    const dept = p.department === undefined || p.department === null ? null : text(p.department, `${at}.department`, 32);
    if (dept && !departments.some((d) => d.id === dept)) throw new Error(`${at}.department: ${dept} is not under departments.`);
    const manager = p.manager === undefined || p.manager === null ? null : email(p.manager, `${at}.manager`);
    if (manager === e) throw new Error(`${at}.manager: nobody is their own manager.`);
    people.push({
      email: e,
      name: p.name === undefined || p.name === null ? null : text(p.name, `${at}.name`, 120),
      employeeId: p.employee_id === undefined || p.employee_id === null ? null : text(p.employee_id, `${at}.employee_id`, 40),
      department: dept,
      manager,
    });
  }

  // Approval chains.
  const ap = doc.approvals ?? {};
  if (!isObj(ap)) throw new Error("approvals is a map with chain and departments.");
  keys(ap, "approvals", ["chain", "departments"]);
  const chain = ap.chain === undefined ? [{ approver: "manager", over: 0 }] : stepsOf(ap.chain, "approvals.chain");
  const byDept: Record<string, Step[]> = {};
  const ad = ap.departments ?? {};
  if (!isObj(ad)) throw new Error("approvals.departments is a map of department ids to their own chain.");
  for (const [d, steps] of Object.entries(ad)) {
    if (!departments.some((x) => x.id === d)) throw new Error(`approvals.departments.${d}: ${d} is not under departments.`);
    byDept[d] = stepsOf(steps, `approvals.departments.${d}`);
  }

  // Projects, for when Time is not linked.
  const projects: Config["projects"] = [];
  const pj = doc.projects ?? {};
  if (!isObj(pj) || Object.keys(pj).length > 2000) throw new Error("projects is a map of project ids to names, such as acme: Acme rollout.");
  for (const [id, v] of Object.entries(pj)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error(`projects.${id}: a project id is up to 64 letters, digits, _, . and -.`);
    if (isObj(v)) keys(v, `projects.${id}`, ["name"]);
    const name = v === null ? id : isObj(v) ? (v.name === undefined ? id : text(v.name, `projects.${id}.name`, 120)) : text(v, `projects.${id}`, 120);
    projects.push({ id, name });
  }

  // Company card statements.
  const cd = doc.cards ?? {};
  if (!isObj(cd)) throw new Error("cards is a map with columns, holders, match_days and purchases.");
  keys(cd, "cards", ["columns", "holders", "match_days", "purchases"]);
  const columns = { ...CARD_COLUMNS };
  if (cd.columns !== undefined) {
    if (!isObj(cd.columns)) throw new Error(`cards.columns is a map of ${Object.keys(CARD_COLUMNS).join(", ")} to the statement's header.`);
    keys(cd.columns, "cards.columns", Object.keys(CARD_COLUMNS));
    for (const [k, v] of Object.entries(cd.columns)) columns[k as CardColumn] = [text(v, `cards.columns.${k}`, 80)];
  }
  const holders: Record<string, string> = {};
  const hs = cd.holders ?? {};
  if (!isObj(hs)) throw new Error("cards.holders is a map of a card's last four digits to its holder's email, such as \"4417\": ali@example.com.");
  for (const [last4, who] of Object.entries(hs)) {
    if (!/^\d{4}$/.test(last4)) throw new Error(`cards.holders.${last4}: a card is named by its last four digits, in quotes, such as "4417".`);
    holders[last4] = email(who, `cards.holders.${last4}`);
  }
  const purchases = cd.purchases ?? "positive";
  if (purchases !== "positive" && purchases !== "negative") throw new Error("cards.purchases is positive or negative: how the statement writes a purchase.");
  const cards = {
    columns,
    holders,
    matchDays: cd.match_days === undefined ? 3 : days(cd.match_days, "cards.match_days", 0, 30),
    purchases: purchases as "positive" | "negative",
  };

  // Exports for the accountant.
  const ex = doc.exports ?? {};
  if (!isObj(ex)) throw new Error("exports is a map with separator and decimal.");
  keys(ex, "exports", ["separator", "decimal"]);
  const separator = ex.separator === undefined ? ";" : ex.separator === "tab" ? "\t" : ex.separator;
  if (separator !== ";" && separator !== "," && separator !== "\t") throw new Error('exports.separator is ";", "," or tab.');
  const decimal = ex.decimal ?? ",";
  if (decimal !== "," && decimal !== ".") throw new Error('exports.decimal is "," or ".".');
  if (separator === decimal) throw new Error("exports.separator and exports.decimal must differ.");

  const link = (v: unknown, at: string, token: string) => {
    if (v === undefined || v === null) return null;
    if (!isObj(v)) throw new Error(`${at} is a map with url, token and every.`);
    keys(v, at, ["url", "token", "every"]);
    const m = /^(\d{1,4})\s*m$/.exec(String(v.every ?? "15m").trim());
    const everyMinutes = m ? Number(m[1]) : NaN;
    if (!(everyMinutes >= 1 && everyMinutes <= 1440)) throw new Error(`${at}.every is 1m to 1440m, such as 15m.`);
    return { url: baseUrl(v.url, `${at}.url`), token: v.token === undefined ? token : env(v.token, `${at}.token`), everyMinutes };
  };

  return {
    timeZone,
    currencies,
    rates,
    receipts,
    kdvRates,
    categories,
    approvals: { chain, departments: byDept },
    departments,
    people,
    projects,
    cards,
    exports: { separator, decimal },
    hr: link(doc.hr, "hr", "EXPENSES_HR_TOKEN"),
    time: link(doc.time, "time", "EXPENSES_TIME_TOKEN"),
  };
}

/** Things to fix that do not stop the file from being applied: secrets that are not set, approvers who are not members. */
export function configWarnings(c: Config, environment: Record<string, string | undefined>, members: string[]): string[] {
  const w: string[] = [];
  const unset = (name: string) => !environment[name];
  if (c.receipts.reader?.token && unset(c.receipts.reader.token)) w.push(`receipts.reader: ${c.receipts.reader.token} is not set, so receipts are not read.`);
  if (c.hr && unset(c.hr.token)) w.push(`hr: ${c.hr.token} is not set, so people and managers are not read from HR.`);
  if (c.time && unset(c.time.token)) w.push(`time: ${c.time.token} is not set, so projects are not read from Time.`);
  const steps = [...c.approvals.chain, ...Object.values(c.approvals.departments).flat()];
  for (const s of steps)
    if (s.approver !== "manager" && s.approver !== "finance" && !members.includes(s.approver)) w.push(`approvals: ${s.approver} is not a member of Expenses.`);
  if (!c.hr)
    for (const p of c.people) if (p.manager && !members.includes(p.manager)) w.push(`people.${p.email}.manager: ${p.manager} is not a member of Expenses.`);
  for (const [last4, who] of Object.entries(c.cards.holders)) if (!members.includes(who)) w.push(`cards.holders.${last4}: ${who} is not a member of Expenses.`);
  return [...new Set(w)];
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
