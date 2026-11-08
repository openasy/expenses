// The other services Expenses talks to, each behind a small interface so the tests can point it at a fake:
//
// - HR: people, their department and manager, read from GET /api/v1/employees?status=current (hr/openapi.json): each
//   employee's workEmail, department { id, name } and manager { id, name }, the manager's email found by their id in
//   the same list. Without HR, the file's `people` are used.
// - Time: projects expenses are charged to, read from GET /api/v1/projects. Without Time, the file's `projects`.
// - A receipt reader: a service on your network that reads a receipt's amount, date and seller (POST /read with the
//   file as the body). Expenses ships none; anything it does not read clearly is typed in.
//
// Payroll is not called: it takes approved claims from GET /api/v1/payroll here (see app.ts), as the run is Payroll's.
import { knownCurrency, minorDigits, parseDecimal, taxNumber } from "./money.ts";
import { isDay } from "./store.ts";

export class LinkError extends Error {
  /** true when sending the same again gives the same answer: a refused body or token. */
  readonly permanent: boolean;
  readonly status: number | null;
  constructor(message: string, status: number | null = null, permanent = false) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 200): string | null =>
  (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim().slice(0, max) : null;
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const mail = (v: unknown): string | null => {
  const s = str(v, 254);
  return s && EMAIL.test(s) ? s.toLowerCase() : null;
};

async function getJson(f: typeof fetch, url: string, token: string | null, product: string): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, {
      headers: { ...(token && { authorization: `Bearer ${token}` }), accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch (err) {
    throw new LinkError(`${product} could not be reached: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = str(obj(body)?.detail, 300);
    throw new LinkError(`${product} answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, res.status === 401 || res.status === 403);
  }
  return body;
}

// ------------------------------------------------------------------ HR

export interface HrPerson {
  email: string;
  name: string | null;
  employeeId: string | null;
  /** The department's id, or its name when HR gives no id. */
  department: string | null;
  departmentName: string | null;
  manager: string | null;
  active: boolean;
}

export interface HrLink {
  people(): Promise<HrPerson[]>;
}

/** One person as HR answers it; tolerant of the ways a department and a manager can be written. */
export function readHrPerson(v: unknown): HrPerson | null {
  const p = obj(v);
  const email = mail(p?.email ?? p?.workEmail ?? p?.work_email);
  if (!p || !email) return null;
  const dept = obj(p.department) ?? obj(p.team);
  const deptRaw = dept ? (str(dept.id, 64) ?? str(dept.name, 64)) : str(p.department ?? p.departmentId ?? p.department_id ?? p.team, 64);
  const manager = mail(obj(p.manager)?.email ?? p.managerEmail ?? p.manager_email ?? p.manager);
  const status = str(p.status, 20)?.toLowerCase();
  return {
    email,
    name: str(p.name ?? [p.firstName, p.lastName].filter(Boolean).join(" "), 120),
    employeeId: str(obj(p.work)?.number ?? p.employeeId ?? p.employee_id ?? p.number ?? p.id, 40),
    department: deptRaw,
    departmentName: dept ? str(dept.name, 120) : null,
    manager: manager === email ? null : manager,
    active: p.active === false ? false : !status || ["active", "joining", "on_leave", "on-leave"].includes(status),
  };
}

export function hrLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): HrLink {
  const f = o.fetch ?? fetch;
  return {
    async people() {
      if (!o.token) throw new LinkError("The HR token is not set.", null, true);
      const body = obj(await getJson(f, `${o.url}/api/v1/employees?status=current`, o.token, "HR"));
      const list = Array.isArray(body?.employees) ? body.employees : Array.isArray(body?.people) ? body.people : null;
      if (!list) throw new LinkError("HR's answer has no employees list.");
      // HR names a manager by their record's id; their email is on their own record.
      const emailById = new Map<string, string>();
      for (const v of list) {
        const e = obj(v);
        const id = str(e?.id, 64);
        const email = mail(e?.workEmail ?? e?.email);
        if (id && email) emailById.set(id, email);
      }
      const out: HrPerson[] = [];
      for (const v of list) {
        const e = obj(v);
        if (!e) continue;
        const managerId = str(obj(e.manager)?.id, 64);
        const p = readHrPerson(managerId && !obj(e.manager)?.email ? { ...e, managerEmail: emailById.get(managerId) ?? null, manager: undefined } : e);
        if (p) out.push(p);
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------ Time

export interface TimeProject {
  id: string;
  name: string;
  active: boolean;
}

export interface TimeLink {
  projects(): Promise<TimeProject[]>;
}

export function timeLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): TimeLink {
  const f = o.fetch ?? fetch;
  return {
    async projects() {
      if (!o.token) throw new LinkError("The Time token is not set.", null, true);
      const body = obj(await getJson(f, `${o.url}/api/v1/projects?status=all`, o.token, "Time"));
      if (!Array.isArray(body?.projects)) throw new LinkError("Time's answer has no projects list.");
      const out: TimeProject[] = [];
      for (const v of body.projects) {
        const p = obj(v);
        const id = str(p?.code, 64) ?? str(p?.id, 64);
        const name = str(p?.name, 120);
        if (!p || !id || !name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) continue;
        const status = str(p.status, 20)?.toLowerCase();
        out.push({ id, name, active: p.active === false || p.archived === true ? false : !status || status === "active" || status === "open" });
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------ the receipt reader

/** What a reader found on a receipt, in the form Expenses keeps: amounts in minor units. */
export interface ReadFields {
  confidence: number | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  seller: string | null;
  sellerTaxNumber: string | null;
  documentNumber: string | null;
  vat: Array<{ rate: number; amount: number }>;
}

export interface ReceiptReader {
  read(file: { data: Buffer; contentType: string }): Promise<ReadFields>;
}

/**
 * Takes a reader's answer: `{ confidence, amount: "640.00", currency, date, seller, taxNumber, documentNumber,
 * vat: [{ rate: 10, amount: "58.18" }] }`, amounts in the currency's units as text or numbers. Whatever does not
 * read as its type is left out.
 */
export function readFieldsFrom(v: unknown): ReadFields {
  const a = obj(v) ?? {};
  const cur = str(a.currency, 3)?.toUpperCase();
  const currency = cur && knownCurrency(cur) ? cur : null;
  const digits = minorDigits(currency ?? "TRY");
  const money = (x: unknown) => {
    const n = typeof x === "number" ? parseDecimal(x.toFixed(digits), digits) : typeof x === "string" ? parseDecimal(x, digits) : null;
    return n !== null && n > 0 ? n : null;
  };
  const conf = typeof a.confidence === "number" && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null;
  const vat = Array.isArray(a.vat)
    ? a.vat.flatMap((x) => {
        const r = obj(x);
        const rate = typeof r?.rate === "number" && r.rate >= 0 && r.rate <= 100 ? r.rate : null;
        const amount = money(r?.amount);
        return rate !== null && amount !== null ? [{ rate, amount }] : [];
      })
    : [];
  const tax = str(a.taxNumber ?? a.tax_number, 20);
  return {
    confidence: conf,
    amount: money(a.amount ?? a.total),
    currency,
    date: isDay(a.date) ? a.date : null,
    seller: str(a.seller ?? a.merchant, 120),
    sellerTaxNumber: tax ? taxNumber(tax) : null,
    documentNumber: str(a.documentNumber ?? a.document_number, 60),
    vat,
  };
}

export function httpReader(o: { url: string; token: string | undefined; fetch?: typeof fetch }): ReceiptReader {
  const f = o.fetch ?? fetch;
  return {
    async read(file) {
      let res: Response;
      try {
        res = await f(`${o.url}/read`, {
          method: "POST",
          headers: { ...(o.token && { authorization: `Bearer ${o.token}` }), "content-type": file.contentType, accept: "application/json" },
          body: new Uint8Array(file.data),
          signal: AbortSignal.timeout(60_000),
          redirect: "error",
        });
      } catch (err) {
        throw new LinkError(`The receipt reader could not be reached: ${(err as Error).message}`);
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        throw new LinkError(`The receipt reader answered ${res.status}`, res.status, permanent);
      }
      return readFieldsFrom(body);
    },
  };
}
