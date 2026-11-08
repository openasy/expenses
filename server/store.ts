// What the parts of Expenses share: the error the API turns into a problem, who does something, the database helpers
// and the checks that read a request's fields.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Role } from "@openasy/auth";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "not-available"
  | "link-failed"
  | "rate-limited"
  | "payload-too-large"
  | "unsupported-media-type"
  | "internal-error";

export class ExpensesError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Who does something: a signed-in member (with their email), an API token (without one), or the tests' tokens. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
  email: string | null;
}

export const bad = (message: string) => new ExpensesError(422, "invalid-body", message);
export const notFound = (what: string) => new ExpensesError(404, "not-found", `${what} does not exist.`);
export const conflict = (message: string) => new ExpensesError(409, "conflict", message);
export const forbidden = (message: string) => new ExpensesError(403, "forbidden", message);
export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const DAY = 86_400_000;
export const MINUTE = 60_000;

export function createStore(db: DatabaseSync, clock: () => number) {
  let depth = 0;
  return {
    db,
    clock,
    iso: (ms = clock()) => new Date(ms).toISOString(),
    q: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[],
    one: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined,
    run: (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args),
    /**
     * Runs fn in one write transaction. BEGIN IMMEDIATE takes the write lock at once, so a check and the write that
     * follows it cannot be split by another writer, in this process or another on the same file.
     */
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
  };
}
export type Store = ReturnType<typeof createStore>;

/** The body as a map, or a 422 that says what it takes. */
export function body(v: unknown, takes: string[]): Record<string, unknown> {
  if (!isObj(v)) throw bad(`The body is a JSON object with ${takes.join(", ")}.`);
  const extra = Object.keys(v).filter((k) => !takes.includes(k));
  if (extra.length) throw bad(`unknown ${extra.join(", ")}; it takes ${takes.join(", ")}.`);
  return v;
}

/** A required text field. */
export function text(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw bad(`${field} is a text of 1 to ${max} characters.`);
  return v.trim();
}

/** A text field that may be left out (undefined), cleared (null or ""), or set. */
export function optText(v: unknown, field: string, max = 200): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  return text(v, field, max);
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export function email(v: unknown, field = "email"): string {
  const s = text(v, field, 254);
  if (!EMAIL.test(s)) throw bad(`${field} is an email address.`);
  return s.toLowerCase();
}

/** True for a real calendar day written YYYY-MM-DD. */
export const isDay = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

export function day(v: unknown, field: string): string {
  if (!isDay(v)) throw bad(`${field} is a day, YYYY-MM-DD.`);
  return v;
}

/** An amount in minor units (kuruş for TRY, cents for EUR): a whole number from 1 up. */
export function minor(v: unknown, field: string, { zero = false } = {}): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < (zero ? 0 : 1) || v > 1e13)
    throw bad(`${field} is a whole number of minor units (kuruş for TRY, cents for EUR)${zero ? ", 0 or more" : ", 1 or more"}.`);
  return v;
}

/** The day a moment falls on in a time zone, YYYY-MM-DD. */
export function localDay(ms: number, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The minutes past midnight a moment falls on in a time zone. */
export function localMinutes(ms: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  return Number(p.find((x) => x.type === "hour")?.value) * 60 + Number(p.find((x) => x.type === "minute")?.value);
}

/** A day plus n days, YYYY-MM-DD. */
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Days from a to b. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
