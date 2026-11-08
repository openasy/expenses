// Expenses: receipts, claims and their items, the policy, the approval chain, reimbursement batches, and the people
// and projects from HR and Time. Card statements are in cards.ts and reports and exports in reports.ts; the HTTP layer
// (app.ts) is outside. Everything here works on the database and the applied settings.
//
// Who sees what: every member (the user role is enough) sends their own claims and approves the steps that name them;
// viewers read every claim and the reports; editors are finance: they approve finance steps, pass a step to someone
// else, pay claims in batches and import card statements; admins also manage members and tokens.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { atLeast } from "@openasy/auth";
import { planChain } from "./approvals.ts";
import { configWarnings, type Category, type Config, type ConfigFileState } from "./config.ts";
import { hrLink, httpReader, LinkError, timeLink, type HrLink, type ReadFields, type ReceiptReader, type TimeLink } from "./links.ts";
import { log } from "./log.ts";
import { decimalText, iban as checkIban, kdvOf, knownCurrency, minorDigits, rateText, share, taxNumber, toKurus } from "./money.ts";
import { checkItems, claimBlocks, sellerKey, type Flag, type PolicyItem } from "./policy.ts";
import { sniff, unsafePdf } from "./sniff.ts";
import { stripMetadata, StripError } from "./strip.ts";
import {
  bad,
  body,
  conflict,
  createStore,
  day,
  DAY,
  email as emailOf,
  ExpensesError,
  forbidden,
  isObj,
  localDay,
  MINUTE,
  minor,
  notFound,
  optText,
  text,
  type Actor,
} from "./store.ts";
import { createRateBook } from "./tcmb.ts";

export { ExpensesError, type Actor, type ProblemCode } from "./store.ts";

// ------------------------------------------------------------------ rows

export interface ClaimRow {
  id: string;
  number: string;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  department: string | null;
  title: string;
  state: "draft" | "submitted" | "approved" | "rejected" | "paid";
  round: number;
  total: number;
  reimbursable: number;
  batch_id: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemRow {
  id: string;
  claim_id: string;
  position: number;
  kind: "receipt" | "mileage" | "per_diem";
  category: string;
  project: string | null;
  date: string;
  description: string | null;
  seller: string | null;
  seller_key: string | null;
  seller_tax_number: string | null;
  document: "invoice" | "receipt" | "other" | "none";
  document_number: string | null;
  currency: string;
  amount: number;
  rate_micro: number | null;
  rate_day: string | null;
  rate_source: "none" | "tcmb" | "card" | "pending";
  amount_try: number | null;
  vat: string;
  km_tenths: number | null;
  route: string | null;
  half_days: number | null;
  country: string | null;
  receipt_id: string | null;
  no_receipt_reason: string | null;
  paid_by: "employee" | "company";
  card_tx_id: string | null;
  read_used: string | null;
  flags: string;
  held: number;
  created_at: string;
  updated_at: string;
}

export interface StepRow {
  id: string;
  claim_id: string;
  round: number;
  position: number;
  kind: "manager" | "finance" | "member";
  approver_email: string | null;
  why: string;
  state: "waiting" | "pending" | "approved" | "rejected" | "returned" | "cancelled";
  by_id: string | null;
  by_name: string | null;
  at: string | null;
  comment: string | null;
}

export interface ReceiptRow {
  id: string;
  owner_id: string;
  owner_email: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  read_state: "none" | "pending" | "read" | "unclear" | "failed";
  read_fields: string | null;
  read_error: string | null;
  read_attempts: number;
  created_at: string;
}

export interface BatchRow {
  id: string;
  number: string;
  method: "payroll" | "transfer";
  state: "open" | "sent" | "paid";
  pay_date: string;
  total: number;
  created_by: string;
  created_at: string;
  sent_at: string | null;
  paid_at: string | null;
  paid_by: string | null;
}

export interface PersonRow {
  email: string;
  name: string | null;
  employee_id: string | null;
  department: string | null;
  department_name: string | null;
  manager_email: string | null;
  source: "hr" | "file";
  active: number;
  updated_at: string;
}

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface ExpensesOptions {
  /** The address people open Expenses at, for links in what other products are sent. */
  publicUrl: string;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
  /** For tests: what fetches TCMB's rates. */
  fetch?: typeof fetch;
  /** For tests: what talks to HR, Time and the receipt reader, instead of the real clients. */
  hr?: (c: Config) => HrLink | null;
  time?: (c: Config) => TimeLink | null;
  reader?: (c: Config) => ReceiptReader | null;
}

interface LinkState {
  okAt: string | null;
  errorAt: string | null;
  error: string | null;
}

const ITEM_FIELDS = [
  "category",
  "project",
  "date",
  "description",
  "seller",
  "sellerTaxNumber",
  "document",
  "documentNumber",
  "currency",
  "amount",
  "vat",
  "km",
  "route",
  "days",
  "country",
  "receipt",
  "noReceiptReason",
  "cardTransaction",
];

const CLAIM_STATES = ["draft", "submitted", "approved", "rejected", "paid"] as const;

export function createExpenses(db: DatabaseSync, opts: ExpensesOptions) {
  const clock = opts.clock ?? Date.now;
  const env = opts.env ?? process.env;
  const store = createStore(db, clock);
  const { q, one, run, tx, iso } = store;
  const rates = createRateBook(store, { fetch: opts.fetch });
  let config: Config | null = null;
  let configText = "";
  let hr: HrLink | null = null;
  let time: TimeLink | null = null;
  let reader: ReceiptReader | null = null;
  const links: Record<"hr" | "time" | "reader" | "tcmb", LinkState> = {
    hr: { okAt: null, errorAt: null, error: null },
    time: { okAt: null, errorAt: null, error: null },
    reader: { okAt: null, errorAt: null, error: null },
    tcmb: { okAt: null, errorAt: null, error: null },
  };
  const linkOk = (k: keyof typeof links) => Object.assign(links[k], { okAt: iso(), error: null });
  const linkFailed = (k: keyof typeof links, err: unknown) =>
    Object.assign(links[k], { errorAt: iso(), error: err instanceof Error ? err.message : String(err) });
  const counters = { receipts: new Map<string, number>(), decisions: new Map<string, number>(), syncs: new Map<string, number>() };
  const count = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  let lastHrSync = 0;
  let lastTimeSync = 0;

  // ------------------------------------------------------------------ settings

  function cfg(): Config {
    if (!config) throw new ExpensesError(503, "not-available", "The settings file is not applied yet.");
    return config;
  }
  const today = () => localDay(clock(), cfg().timeZone);

  const team = (): Member[] => {
    try {
      return q<Member>("SELECT id, name, email, role FROM auth_users WHERE status != 'disabled' ORDER BY name COLLATE NOCASE");
    } catch {
      return [];
    }
  };
  const memberByEmail = (e: string | null | undefined) => (e ? team().find((m) => m.email.toLowerCase() === e.toLowerCase()) : undefined);

  function setConfig(c: Config, raw: string): string[] {
    config = c;
    configText = raw;
    hr = opts.hr ? opts.hr(c) : c.hr ? hrLink({ url: c.hr.url, token: env[c.hr.token] }) : null;
    time = opts.time ? opts.time(c) : c.time ? timeLink({ url: c.time.url, token: env[c.time.token] }) : null;
    reader = opts.reader
      ? opts.reader(c)
      : c.receipts.reader
        ? httpReader({ url: c.receipts.reader.url, token: c.receipts.reader.token ? env[c.receipts.reader.token] : undefined })
        : null;
    // The file's people and projects stand in for HR's and Time's until those are linked.
    tx(() => {
      if (!c.hr) {
        run("DELETE FROM people WHERE source = 'file'");
        for (const p of c.people)
          run(
            `INSERT INTO people (email, name, employee_id, department, department_name, manager_email, source, active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'file', 1, ?)
             ON CONFLICT (email) DO UPDATE SET name = excluded.name, employee_id = excluded.employee_id, department = excluded.department,
               department_name = excluded.department_name, manager_email = excluded.manager_email, source = 'file', active = 1, updated_at = excluded.updated_at`,
            p.email,
            p.name,
            p.employeeId,
            p.department,
            c.departments.find((d) => d.id === p.department)?.name ?? null,
            p.manager,
            iso(),
          );
      }
      if (!c.time) {
        run("DELETE FROM projects WHERE source = 'file'");
        for (const p of c.projects)
          run(
            `INSERT INTO projects (id, name, source, active, updated_at) VALUES (?, ?, 'file', 1, ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = 'file', active = 1, updated_at = excluded.updated_at`,
            p.id,
            p.name,
            iso(),
          );
      }
    });
    lastHrSync = 0;
    lastTimeSync = 0;
    const warnings = configWarnings(
      c,
      env,
      team().map((m) => m.email.toLowerCase()),
    );
    for (const r of q<{ category: string; n: number }>(
      "SELECT i.category, COUNT(*) AS n FROM items i JOIN claims c ON c.id = i.claim_id WHERE c.state = 'draft' GROUP BY i.category",
    ))
      if (!c.categories.some((x) => x.id === r.category))
        warnings.push(`${r.n} items in draft claims are in the category ${r.category}, which the file no longer has; they cannot be sent until it is changed.`);
    return warnings;
  }

  function settings() {
    const c = config;
    return {
      file: opts.fileState?.() ?? null,
      yaml: configText,
      config: c && {
        timeZone: c.timeZone,
        currencies: c.currencies,
        rates: c.rates,
        receipts: { ...c.receipts, reader: c.receipts.reader && { url: c.receipts.reader.url, minConfidence: c.receipts.reader.minConfidence } },
        kdvRates: c.kdvRates,
        categories: c.categories,
        approvals: c.approvals,
        departments: c.departments,
        cards: c.cards,
        exports: c.exports,
        hr: c.hr && { url: c.hr.url, token: c.hr.token, everyMinutes: c.hr.everyMinutes },
        time: c.time && { url: c.time.url, token: c.time.token, everyMinutes: c.time.everyMinutes },
      },
    };
  }

  /** What a member needs to fill in a claim: categories, limits, rates and currencies. */
  function policy() {
    const c = cfg();
    return {
      currencies: ["TRY", ...(c.currencies ?? rates.known().filter((x) => x !== "TRY"))],
      rates: { source: "tcmb", use: c.rates.kind, day: c.rates.day },
      kdvRates: c.kdvRates,
      receipts: { maxSize: c.receipts.maxSize, types: c.receipts.types, maxAgeDays: c.receipts.maxAgeDays, read: !!reader },
      categories: c.categories.map(categoryOut),
    };
  }

  const categoryOut = (cat: Category) => ({
    id: cat.id,
    name: cat.name,
    kind: cat.kind,
    account: cat.account,
    kdv: cat.kdv,
    limits: cat.limits,
    overLimit: cat.overLimit,
    project: cat.project,
    perKm: cat.perKm,
    perDay: cat.perDay,
  });

  // ------------------------------------------------------------------ people and projects

  const person = (e: string) => one<PersonRow>("SELECT * FROM people WHERE email = ? AND active = 1", e.toLowerCase());

  function departmentName(id: string | null): string | null {
    if (!id) return null;
    return (
      cfg().departments.find((d) => d.id === id)?.name ??
      one<{ department_name: string | null }>("SELECT department_name FROM people WHERE department = ? AND department_name IS NOT NULL LIMIT 1", id)
        ?.department_name ??
      id
    );
  }

  function people() {
    const members = new Set(team().map((m) => m.email.toLowerCase()));
    return q<PersonRow>("SELECT * FROM people WHERE active = 1 ORDER BY COALESCE(name, email) COLLATE NOCASE").map((p) => ({
      email: p.email,
      name: p.name,
      employeeId: p.employee_id,
      department: p.department ? { id: p.department, name: departmentName(p.department)! } : null,
      manager: p.manager_email,
      source: p.source,
      member: members.has(p.email),
    }));
  }

  const projects = () => q<{ id: string; name: string }>("SELECT id, name FROM projects WHERE active = 1 ORDER BY name COLLATE NOCASE");
  const projectOut = (id: string | null) => (id ? { id, name: one<{ name: string }>("SELECT name FROM projects WHERE id = ?", id)?.name ?? id } : null);

  async function syncHr(): Promise<void> {
    if (!hr) return;
    try {
      const list = await hr.people();
      const c = cfg();
      tx(() => {
        run("UPDATE people SET active = 0 WHERE source = 'hr' OR source = 'file'");
        for (const p of list) {
          // A department HR names by name is matched to the file's by id or name, so its chain applies.
          const names = [p.department, p.departmentName].filter((n): n is string => !!n).map((n) => n.toLocaleLowerCase("tr"));
          const known = c.departments.find((d) => d.id === p.department || names.includes(d.name.toLocaleLowerCase("tr")));
          run(
            `INSERT INTO people (email, name, employee_id, department, department_name, manager_email, source, active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'hr', ?, ?)
             ON CONFLICT (email) DO UPDATE SET name = excluded.name, employee_id = excluded.employee_id, department = excluded.department,
               department_name = excluded.department_name, manager_email = excluded.manager_email, source = 'hr', active = excluded.active,
               updated_at = excluded.updated_at`,
            p.email,
            p.name,
            p.employeeId,
            known?.id ?? p.department,
            known?.name ?? p.departmentName ?? p.department,
            p.manager,
            p.active ? 1 : 0,
            iso(),
          );
        }
      });
      linkOk("hr");
      count(counters.syncs, "hr:ok");
    } catch (err) {
      linkFailed("hr", err);
      count(counters.syncs, "hr:failed");
      log("warn", "people not read from HR", { error: (err as Error).message });
    }
  }

  async function syncTime(): Promise<void> {
    if (!time) return;
    try {
      const list = await time.projects();
      tx(() => {
        run("UPDATE projects SET active = 0");
        for (const p of list)
          run(
            `INSERT INTO projects (id, name, source, active, updated_at) VALUES (?, ?, 'time', ?, ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = 'time', active = excluded.active, updated_at = excluded.updated_at`,
            p.id,
            p.name,
            p.active ? 1 : 0,
            iso(),
          );
      });
      linkOk("time");
      count(counters.syncs, "time:ok");
    } catch (err) {
      linkFailed("time", err);
      count(counters.syncs, "time:failed");
      log("warn", "projects not read from Time", { error: (err as Error).message });
    }
  }

  // ------------------------------------------------------------------ who may do what

  function mustPerson(who: Actor): string {
    if (!who.email) throw forbidden("Claims and receipts are a person's: sign in. An API token has none of its own.");
    return who.email.toLowerCase();
  }
  const isFinance = (who: Actor) => atLeast(who.role, "editor");
  const approverOf = (claimId: string, e: string | null) =>
    !!e && !!one("SELECT 1 FROM steps WHERE claim_id = ? AND approver_email = ? AND state != 'waiting' LIMIT 1", claimId, e.toLowerCase());
  const canSee = (who: Actor, c: ClaimRow) => atLeast(who.role, "viewer") || c.owner_id === who.id || approverOf(c.id, who.email);

  function mustClaim(id: string): ClaimRow {
    const c = one<ClaimRow>("SELECT * FROM claims WHERE id = ? OR number = ?", id, id);
    if (!c) throw notFound("The claim");
    return c;
  }
  function seeClaim(who: Actor, id: string): ClaimRow {
    const c = mustClaim(id);
    if (!canSee(who, c)) throw notFound("The claim");
    return c;
  }
  function ownDraft(who: Actor, c: ClaimRow): void {
    if (c.owner_id !== who.id) throw forbidden(`This claim is ${c.owner_name}'s; only they change it.`);
    if (c.state !== "draft") throw conflict(`The claim is ${c.state}; only a draft is changed. Withdraw it first if it is waiting for approval.`);
  }

  // ------------------------------------------------------------------ numbers

  function nextNumber(prefix: string, width: number): string {
    const year = today().slice(0, 4);
    const name = `${prefix}:${year}`;
    run("INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = value + 1", name);
    const n = one<{ value: number }>("SELECT value FROM counters WHERE name = ?", name)!.value;
    return `${prefix}-${year}-${String(n).padStart(width, "0")}`;
  }

  // ------------------------------------------------------------------ receipts

  function receiptOut(r: ReceiptRow) {
    const fields = r.read_fields ? (JSON.parse(r.read_fields) as ReadFields) : null;
    return {
      id: r.id,
      filename: r.filename,
      contentType: r.content_type,
      size: r.size,
      sha256: r.sha256,
      url: `/api/v1/receipts/${r.id}/file`,
      read: { state: r.read_state, fields, error: r.read_error },
      used: q<{ number: string }>("SELECT DISTINCT c.number FROM items i JOIN claims c ON c.id = i.claim_id WHERE i.receipt_id = ?", r.id).map((x) => x.number),
      createdAt: r.created_at,
    };
  }

  function addReceipt(who: Actor, declaredType: string, filename: string, data: Buffer): { created: boolean; receipt: ReturnType<typeof receiptOut> } {
    const owner = mustPerson(who);
    const c = cfg();
    if (!data.length) throw bad("The body is the receipt's file: a photo or a PDF.");
    if (data.length > c.receipts.maxSize)
      throw new ExpensesError(413, "payload-too-large", `A receipt is at most ${Math.round(c.receipts.maxSize / 1024 / 1024)} MB.`);
    const type = sniff(data);
    const allowed = c.receipts.types;
    if (!type || !allowed.includes(type))
      throw new ExpensesError(
        415,
        "unsupported-media-type",
        `A receipt is a ${allowed.map((t) => t.split("/")[1]!.toUpperCase()).join(", ")} file; these bytes are ${type ?? "none of them"}.`,
      );
    const declared = declaredType.split(";")[0]!.trim().toLowerCase();
    if (declared && declared !== "application/octet-stream" && declared !== type && !(declared === "image/heif" && type === "image/heic"))
      throw new ExpensesError(415, "unsupported-media-type", `The file was sent as ${declared}, but its bytes are ${type}.`);
    if (type === "application/pdf") {
      const why = unsafePdf(data);
      if (why) throw new ExpensesError(415, "unsupported-media-type", why);
    }
    // EXIF (with the GPS position), XMP, IPTC and comments go before anything is kept; the hash is of what is kept,
    // so the same photo sent twice is found again however its metadata differed.
    let kept: Buffer;
    try {
      kept = stripMetadata(data, type);
    } catch (err) {
      if (!(err instanceof StripError)) throw err;
      throw new ExpensesError(415, "unsupported-media-type", `${err.message} Its metadata could not be removed, so it is not kept.`);
    }
    const sha = createHash("sha256").update(kept).digest("hex");
    const same = one<ReceiptRow>("SELECT * FROM receipts WHERE sha256 = ? AND owner_id = ?", sha, who.id);
    if (same) return { created: false, receipt: receiptOut(same) };
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" }[type] ?? "bin";
    const clean = filename
      .replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, "")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 120);
    const name = clean ? (clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean.replace(/\.[^.]*$/, "")}.${ext}`) : `receipt.${ext}`;
    const id = randomUUID();
    run(
      `INSERT INTO receipts (id, owner_id, owner_email, filename, content_type, size, sha256, data, read_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      who.id,
      owner,
      name,
      type,
      kept.length,
      sha,
      kept,
      reader ? "pending" : "none",
      iso(),
    );
    count(counters.receipts, "uploaded");
    if (reader) void readReceipts(id);
    return { created: true, receipt: receiptOut(one<ReceiptRow>("SELECT * FROM receipts WHERE id = ?", id)!) };
  }

  function mustReceipt(who: Actor, id: string): ReceiptRow {
    const r = one<ReceiptRow>("SELECT * FROM receipts WHERE id = ?", id);
    if (!r) throw notFound("The receipt");
    if (r.owner_id === who.id || atLeast(who.role, "viewer")) return r;
    const claims = q<ClaimRow>("SELECT DISTINCT c.* FROM items i JOIN claims c ON c.id = i.claim_id WHERE i.receipt_id = ?", id);
    if (claims.some((c) => canSee(who, c))) return r;
    throw notFound("The receipt");
  }

  const getReceipt = (who: Actor, id: string) => receiptOut(mustReceipt(who, id));

  function receiptFile(who: Actor, id: string): { data: Buffer; contentType: string; filename: string } {
    const r = mustReceipt(who, id);
    const row = one<{ data: Uint8Array }>("SELECT data FROM receipts WHERE id = ?", r.id)!;
    return { data: Buffer.from(row.data), contentType: r.content_type, filename: r.filename };
  }

  function removeReceipt(who: Actor, id: string) {
    const r = mustReceipt(who, id);
    if (r.owner_id !== who.id) throw forbidden("Only the person who added a receipt removes it.");
    if (one("SELECT 1 FROM items WHERE receipt_id = ?", id)) throw conflict("The receipt is on an item; take it off the item first.");
    run("DELETE FROM receipts WHERE id = ?", id);
  }

  let reading: Promise<void> | null = null;
  /** Reads waiting receipts (or one), one at a time. A reader that fails is tried three times, then the receipt is typed in. */
  async function readReceipts(only?: string): Promise<void> {
    while (reading) await reading;
    if (!reader) return;
    reading = readNow(reader, only);
    try {
      await reading;
    } finally {
      reading = null;
    }
  }

  async function readNow(reader: ReceiptReader, only?: string): Promise<void> {
    {
      const c = cfg();
      const due = only
        ? q<ReceiptRow>("SELECT * FROM receipts WHERE id = ? AND read_state = 'pending'", only)
        : q<ReceiptRow>("SELECT * FROM receipts WHERE read_state = 'pending' ORDER BY created_at LIMIT 10");
      for (const r of due) {
        const data = Buffer.from(one<{ data: Uint8Array }>("SELECT data FROM receipts WHERE id = ?", r.id)!.data);
        try {
          const f = await reader.read({ data, contentType: r.content_type });
          const min = c.receipts.reader?.minConfidence ?? 0.8;
          const clear = (f.confidence === null || f.confidence >= min) && (f.amount !== null || f.date !== null || f.seller !== null);
          run(
            "UPDATE receipts SET read_state = ?, read_fields = ?, read_error = NULL, read_attempts = read_attempts + 1 WHERE id = ?",
            clear ? "read" : "unclear",
            JSON.stringify(f),
            r.id,
          );
          count(counters.receipts, clear ? "read" : "unclear");
          linkOk("reader");
        } catch (err) {
          const permanent = err instanceof LinkError && err.permanent;
          const failed = permanent || r.read_attempts + 1 >= 3;
          run(
            "UPDATE receipts SET read_state = ?, read_error = ?, read_attempts = read_attempts + 1 WHERE id = ?",
            failed ? "failed" : "pending",
            (err as Error).message,
            r.id,
          );
          if (failed) count(counters.receipts, "failed");
          linkFailed("reader", err);
        }
      }
    }
  }

  // ------------------------------------------------------------------ items

  const vatOf = (i: ItemRow) => JSON.parse(i.vat) as Array<{ rate: number; amount: number }>;
  const flagsOf = (i: ItemRow) => JSON.parse(i.flags) as Flag[];

  function itemOut(i: ItemRow) {
    const vat = vatOf(i);
    const kdv = vat.reduce((s, v) => s + v.amount, 0);
    const r = i.receipt_id ? one<ReceiptRow>("SELECT * FROM receipts WHERE id = ?", i.receipt_id) : undefined;
    const cat = config?.categories.find((x) => x.id === i.category);
    return {
      id: i.id,
      kind: i.kind,
      category: { id: i.category, name: cat?.name ?? i.category, account: cat?.account ?? null, inFile: !!cat },
      project: projectOut(i.project),
      date: i.date,
      description: i.description,
      seller: i.seller,
      sellerTaxNumber: i.seller_tax_number,
      document: i.document,
      documentNumber: i.document_number,
      currency: i.currency,
      amount: i.amount,
      rate:
        i.rate_source === "tcmb" && i.rate_micro !== null
          ? { source: "tcmb" as const, value: rateText(i.rate_micro), micro: i.rate_micro, day: i.rate_day }
          : { source: i.rate_source, value: null, micro: null, day: null },
      amountTry: i.amount_try,
      vat,
      kdv,
      net: i.amount_try === null ? null : i.amount_try - kdv,
      km: i.km_tenths === null ? null : i.km_tenths / 10,
      route: i.route,
      days: i.half_days === null ? null : i.half_days / 2,
      country: i.country,
      receipt: r ? { id: r.id, filename: r.filename, contentType: r.content_type, size: r.size, url: `/api/v1/receipts/${r.id}/file` } : null,
      noReceiptReason: i.no_receipt_reason,
      paidBy: i.paid_by,
      cardTransaction: i.card_tx_id,
      readUsed: i.read_used ? (JSON.parse(i.read_used) as string[]) : [],
      flags: flagsOf(i),
      held: i.held,
      reimbursable: i.paid_by === "employee" && i.amount_try !== null ? i.amount_try - i.held : 0,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    };
  }

  interface Draft {
    kind: ItemRow["kind"];
    category: string;
    project: string | null;
    date: string;
    description: string | null;
    seller: string | null;
    seller_tax_number: string | null;
    document: ItemRow["document"];
    document_number: string | null;
    currency: string;
    amount: number;
    vat: Array<{ rate: number; amount: number }>;
    km_tenths: number | null;
    route: string | null;
    half_days: number | null;
    country: string | null;
    receipt_id: string | null;
    no_receipt_reason: string | null;
    card_tx_id: string | null;
    read_used: string[];
    /** Set when the rate is known without TCMB: TRY, or a card's charge. */
    amount_try: number | null;
    rate_source: ItemRow["rate_source"];
  }

  interface CardTx {
    id: string;
    holder_email: string | null;
    date: string;
    description: string;
    amount_try: number;
    currency: string | null;
    amount: number | null;
    item_id: string | null;
  }

  /** Reads an item's fields over what it had (for a change) and checks them against the file. */
  function readItem(who: Actor, owner: { id: string; email: string }, raw: unknown, was: ItemRow | null): Draft {
    const b = body(raw, ITEM_FIELDS);
    const c = cfg();
    const has = (k: string) => b[k] !== undefined;
    const catId = has("category") ? text(b.category, "category", 32) : was?.category;
    if (!catId) throw bad(`category is one of ${c.categories.map((x) => x.id).join(", ")}.`);
    const cat = c.categories.find((x) => x.id === catId);
    if (!cat) throw bad(`category: ${catId} is not in the file; it has ${c.categories.map((x) => x.id).join(", ")}.`);
    const kind = cat.kind;
    if (was && was.kind !== kind)
      throw bad(`The item is ${was.kind.replace("_", " ")}; ${cat.name} is ${kind.replace("_", " ")}. Remove it and add a new one.`);

    let project = has("project") ? (b.project === null || b.project === "" ? null : text(b.project, "project", 64)) : (was?.project ?? null);
    if (project && !one("SELECT 1 FROM projects WHERE id = ? AND (active = 1 OR id = ?)", project, was?.project ?? ""))
      throw bad(`project: ${project} is not a project.`);
    if (cat.project === "none") project = null;
    const description = has("description") ? (optText(b.description, "description", 500) ?? null) : (was?.description ?? null);

    // A card purchase gives the date, the amount and what was paid in TRY.
    let card: CardTx | null = null;
    const cardId = has("cardTransaction") ? (b.cardTransaction === null ? null : text(b.cardTransaction, "cardTransaction", 64)) : (was?.card_tx_id ?? null);
    if (cardId) {
      card = one<CardTx>("SELECT * FROM card_transactions WHERE id = ?", cardId) ?? null;
      if (!card || (card.holder_email !== owner.email && !isFinance(who))) throw bad(`cardTransaction: ${cardId} is not a purchase on your card.`);
      if (card.item_id && card.item_id !== was?.id) throw bad("cardTransaction: that purchase is on another item already.");
      if (kind !== "receipt") throw bad("A card purchase goes on a receipt item, not mileage or a daily allowance.");
    }

    // The receipt's file, and what the reader read on it.
    const receiptId = has("receipt") ? (b.receipt === null ? null : text(b.receipt, "receipt", 64)) : (was?.receipt_id ?? null);
    let read: ReadFields | null = null;
    if (receiptId) {
      const r = one<ReceiptRow>("SELECT * FROM receipts WHERE id = ?", receiptId);
      if (!r || (r.owner_id !== owner.id && !(card && isFinance(who)))) throw bad(`receipt: ${receiptId} is not one of your receipts.`);
      if (kind !== "receipt") throw bad("Mileage and daily allowances need no receipt.");
      if (r.read_state === "read" && r.read_fields) read = JSON.parse(r.read_fields) as ReadFields;
    }
    const readUsed: string[] = !was || has("receipt") ? [] : was.read_used ? (JSON.parse(was.read_used) as string[]) : [];
    const fill = <T>(field: string, given: T | undefined, fromRead: T | null | undefined, prior: T | undefined): T | undefined => {
      if (given !== undefined) {
        const i = readUsed.indexOf(field);
        if (i >= 0) readUsed.splice(i, 1);
        return given;
      }
      if (has("receipt") && fromRead !== null && fromRead !== undefined && (prior === undefined || prior === null)) {
        readUsed.push(field);
        return fromRead;
      }
      return prior;
    };

    const t = today();
    const date = fill("date", has("date") ? day(b.date, "date") : undefined, read?.date ?? null, was?.date) ?? card?.date;
    if (!date) throw bad("date is the day on the receipt, YYYY-MM-DD.");
    if (has("date") || !was) {
      if (date > t) throw bad(`date: ${date} is after today.`);
      if (date < "2000-01-01") throw bad("date is this century.");
    }

    const out: Draft = {
      kind,
      category: cat.id,
      project,
      date,
      description,
      seller: null,
      seller_tax_number: null,
      document: "none",
      document_number: null,
      currency: "TRY",
      amount: 0,
      vat: [],
      km_tenths: null,
      route: null,
      half_days: null,
      country: null,
      receipt_id: null,
      no_receipt_reason: null,
      card_tx_id: null,
      read_used: [],
      amount_try: null,
      rate_source: "none",
    };

    if (kind === "mileage") {
      for (const k of ["seller", "sellerTaxNumber", "document", "documentNumber", "currency", "amount", "vat", "days", "country", "noReceiptReason"])
        if (has(k)) throw bad(`${k} is not for mileage: it takes km and route, and the amount follows from the file's rate.`);
      const km = has("km") ? b.km : was?.km_tenths !== null && was?.km_tenths !== undefined ? was.km_tenths / 10 : undefined;
      if (typeof km !== "number" || !(km > 0) || km > 10_000 || Math.abs(Math.round(km * 10) - km * 10) > 1e-9)
        throw bad("km is the distance driven, more than 0 and up to 10000, with at most one decimal.");
      out.km_tenths = Math.round(km * 10);
      out.route = has("route") ? (optText(b.route, "route", 300) ?? null) : (was?.route ?? null);
      out.amount = share(out.km_tenths, cat.perKm!, 10);
      out.amount_try = out.amount;
      return out;
    }

    if (kind === "per_diem") {
      for (const k of ["seller", "sellerTaxNumber", "document", "documentNumber", "currency", "amount", "vat", "km", "route", "noReceiptReason"])
        if (has(k)) throw bad(`${k} is not for a daily allowance: it takes days and country, and the amount follows from the file's rates.`);
      const days = has("days") ? b.days : was?.half_days !== null && was?.half_days !== undefined ? was.half_days / 2 : undefined;
      if (typeof days !== "number" || !(days > 0) || days > 90 || !Number.isInteger(days * 2))
        throw bad("days is how many days away, 0.5 to 90, in half days.");
      const country = has("country") ? text(b.country, "country", 2).toUpperCase() : (was?.country ?? "TR");
      if (!/^[A-Z]{2}$/.test(country)) throw bad("country is a two-letter code, such as TR or DE.");
      const rate = cat.perDay![country] ?? cat.perDay!.default;
      if (!rate) throw bad(`country: ${cat.name} has no rate for ${country} and no default.`);
      out.half_days = Math.round(days * 2);
      out.country = country;
      out.currency = rate.currency;
      out.amount = share(rate.amount, out.half_days, 2);
      if (rate.currency === "TRY") out.amount_try = out.amount;
      else out.rate_source = "pending";
      return out;
    }

    // A receipt.
    for (const k of ["km", "route", "days", "country"]) if (has(k)) throw bad(`${k} is for mileage and daily allowances.`);
    out.seller =
      fill("seller", has("seller") ? (optText(b.seller, "seller", 120) ?? null) : undefined, read?.seller ?? null, was?.seller ?? undefined) ??
      card?.description ??
      null;
    const tax = fill(
      "sellerTaxNumber",
      has("sellerTaxNumber") ? (optText(b.sellerTaxNumber, "sellerTaxNumber", 20) ?? null) : undefined,
      read?.sellerTaxNumber ?? null,
      was?.seller_tax_number ?? undefined,
    );
    if (tax && !taxNumber(tax)) throw bad("sellerTaxNumber is a VKN of 10 digits or a TCKN of 11, as printed on the receipt.");
    out.seller_tax_number = tax ? taxNumber(tax) : null;
    out.document_number =
      fill(
        "documentNumber",
        has("documentNumber") ? (optText(b.documentNumber, "documentNumber", 60) ?? null) : undefined,
        read?.documentNumber ?? null,
        was?.document_number ?? undefined,
      ) ?? null;

    let currency =
      fill("currency", has("currency") ? text(b.currency, "currency", 3).toUpperCase() : undefined, read?.currency ?? null, was?.currency) ??
      card?.currency ??
      "TRY";
    if (card && !has("currency") && !was) currency = card.currency ?? "TRY";
    if (currency !== "TRY" && (!knownCurrency(currency) || (c.currencies && !c.currencies.includes(currency))))
      throw bad(
        `currency: ${currency} is not taken; the file takes TRY${c.currencies ? `, ${c.currencies.join(", ")}` : " and the currencies TCMB publishes"}.`,
      );
    out.currency = currency;
    const sameCurrencyRead = read && (read.currency ?? "TRY") === currency ? read : null;
    const cardAmount = card
      ? card.currency && card.amount
        ? card.currency === currency
          ? card.amount
          : null
        : currency === "TRY"
          ? card.amount_try
          : null
      : null;
    const amount =
      fill("amount", has("amount") ? minor(b.amount, "amount") : undefined, sameCurrencyRead?.amount ?? null, was?.amount) ?? cardAmount ?? undefined;
    if (amount === undefined)
      throw bad(`amount is the receipt's total with KDV, in minor units of ${currency} (${minorDigits(currency)} decimals): 64000 is 640.00.`);
    out.amount = amount;

    const docGiven = has("document") ? b.document : undefined;
    if (docGiven !== undefined && !["invoice", "receipt", "other", "none"].includes(docGiven as string))
      throw bad("document is invoice (fatura, e-Arşiv or e-Fatura), receipt (a till receipt, ÖKC fişi), other or none.");
    out.receipt_id = receiptId;
    out.document =
      (docGiven as Draft["document"] | undefined) ?? (was && !has("receipt") ? was.document : receiptId ? (currency === "TRY" ? "receipt" : "other") : "none");
    out.no_receipt_reason = has("noReceiptReason") ? (optText(b.noReceiptReason, "noReceiptReason", 300) ?? null) : (was?.no_receipt_reason ?? null);
    if (receiptId) out.no_receipt_reason = null;

    // KDV: on TRY receipts and invoices only; foreign VAT is not KDV.
    const kdvAllowed = currency === "TRY" && (out.document === "invoice" || out.document === "receipt");
    if (has("vat")) {
      if (!Array.isArray(b.vat) || b.vat.length > 5) throw bad("vat is a list of up to 5 { rate, amount }, one per KDV rate on the receipt.");
      if (b.vat.length && !kdvAllowed)
        throw bad(
          currency !== "TRY" ? "vat: a receipt in another currency carries no Turkish KDV." : "vat: KDV is only on an invoice or a till receipt (document).",
        );
      const lines = b.vat.map((v, i) => {
        if (!isObj(v)) throw bad(`vat[${i}] is { rate, amount }.`);
        body(v, ["rate", "amount"]);
        if (typeof v.rate !== "number" || !c.kdvRates.includes(v.rate)) throw bad(`vat[${i}].rate is one of ${c.kdvRates.join(", ")}.`);
        const max = kdvOf(amount, v.rate);
        const a = v.amount === undefined ? ((b.vat as unknown[]).length === 1 ? max : null) : minor(v.amount, `vat[${i}].amount`, { zero: true });
        if (a === null) throw bad(`vat[${i}].amount: with more than one rate, each rate's KDV is given, as the receipt prints it.`);
        // A rate's KDV cannot be more than the whole receipt at that rate would carry; a kuruş is left for rounding.
        if (a > max + 1) throw bad(`vat[${i}].amount: ${decimalText(a, "TRY")} is more KDV than ${decimalText(amount, "TRY")} holds at ${v.rate}%.`);
        return { rate: v.rate, amount: a };
      });
      if (new Set(lines.map((l) => l.rate)).size !== lines.length) throw bad("vat: each rate once.");
      if (lines.reduce((s, l) => s + l.amount, 0) >= amount && amount > 0) throw bad("vat: the KDV is less than the total.");
      out.vat = lines;
    } else if (was && !has("amount") && !has("document") && !has("currency")) out.vat = kdvAllowed ? vatOf(was) : [];
    else if (kdvAllowed && sameCurrencyRead?.vat.length && readUsed.includes("amount")) {
      out.vat = sameCurrencyRead.vat.filter((v) => c.kdvRates.includes(v.rate) && v.amount <= kdvOf(amount, v.rate) + 1);
      if (out.vat.length) readUsed.push("vat");
    } else if (kdvAllowed && cat.kdv !== null && cat.kdv > 0) out.vat = [{ rate: cat.kdv, amount: kdvOf(amount, cat.kdv) }];

    out.card_tx_id = card?.id ?? null;
    if (card) {
      out.amount_try = card.amount_try;
      out.rate_source = "card";
    } else if (currency === "TRY") out.amount_try = amount;
    else out.rate_source = "pending";
    out.read_used = [...new Set(readUsed)];
    return out;
  }

  /** Fetches the TCMB rate a draft needs. Unreachable: the item waits with its rate pending and is tried again later. */
  async function withRate(d: Draft): Promise<{ rate_micro: number | null; rate_day: string | null }> {
    if (d.rate_source !== "pending") return { rate_micro: null, rate_day: null };
    const c = cfg();
    try {
      const r = await rates.rateFor(d.currency, d.date, c.rates.kind, c.rates.day, c.rates.url, today());
      linkOk("tcmb");
      d.rate_source = "tcmb";
      d.amount_try = toKurus(d.amount, d.currency, r.micro);
      return { rate_micro: r.micro, rate_day: r.day };
    } catch (err) {
      if (err instanceof LinkError) {
        linkFailed("tcmb", err);
        return { rate_micro: null, rate_day: null };
      }
      throw bad(`currency: ${(err as Error).message}`);
    }
  }

  function saveItem(claimId: string, d: Draft, rate: { rate_micro: number | null; rate_day: string | null }, id: string | null): string {
    const cols = {
      kind: d.kind,
      category: d.category,
      project: d.project,
      date: d.date,
      description: d.description,
      seller: d.seller,
      seller_key: d.kind === "receipt" ? sellerKey(d.seller) : null,
      seller_tax_number: d.seller_tax_number,
      document: d.document,
      document_number: d.document_number,
      currency: d.currency,
      amount: d.amount,
      rate_micro: rate.rate_micro,
      rate_day: rate.rate_day,
      rate_source: d.rate_source,
      amount_try: d.amount_try,
      vat: JSON.stringify(d.vat),
      km_tenths: d.km_tenths,
      route: d.route,
      half_days: d.half_days,
      country: d.country,
      receipt_id: d.receipt_id,
      no_receipt_reason: d.no_receipt_reason,
      paid_by: d.card_tx_id ? "company" : "employee",
      card_tx_id: d.card_tx_id,
      read_used: d.read_used.length ? JSON.stringify(d.read_used) : null,
      updated_at: iso(),
    };
    return tx(() => {
      let itemId = id;
      if (itemId) {
        const was = one<{ card_tx_id: string | null }>("SELECT card_tx_id FROM items WHERE id = ?", itemId);
        if (was?.card_tx_id && was.card_tx_id !== d.card_tx_id) run("UPDATE card_transactions SET item_id = NULL WHERE id = ?", was.card_tx_id);
        run(
          `UPDATE items SET ${Object.keys(cols)
            .map((k) => `${k} = ?`)
            .join(", ")} WHERE id = ?`,
          ...Object.values(cols),
          itemId,
        );
      } else {
        itemId = randomUUID();
        const pos = (one<{ n: number | null }>("SELECT MAX(position) AS n FROM items WHERE claim_id = ?", claimId)?.n ?? 0) + 1;
        const all = { id: itemId, claim_id: claimId, position: pos, ...cols, created_at: iso() };
        run(
          `INSERT INTO items (${Object.keys(all).join(", ")}) VALUES (${Object.keys(all)
            .map(() => "?")
            .join(", ")})`,
          ...Object.values(all),
        );
      }
      if (d.card_tx_id) run("UPDATE card_transactions SET item_id = ? WHERE id = ?", itemId, d.card_tx_id);
      refresh(claimId);
      return itemId;
    });
  }

  async function addItem(who: Actor, claimId: string, raw: unknown) {
    const c = mustClaim(claimId);
    ownDraft(who, c);
    if ((one<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE claim_id = ?", c.id)?.n ?? 0) >= 200)
      throw conflict("A claim has at most 200 items; start another.");
    const d = readItem(who, { id: c.owner_id, email: c.owner_email }, raw, null);
    const rate = await withRate(d);
    // The claim may have been sent while the rate was fetched.
    ownDraft(who, mustClaim(c.id));
    const id = saveItem(c.id, d, rate, null);
    if (!d.card_tx_id && d.kind === "receipt") matchCard(id);
    return itemOut(one<ItemRow>("SELECT * FROM items WHERE id = ?", id)!);
  }

  function mustItem(who: Actor, id: string): { item: ItemRow; claim: ClaimRow } {
    const item = one<ItemRow>("SELECT * FROM items WHERE id = ?", id);
    if (!item) throw notFound("The item");
    const claim = mustClaim(item.claim_id);
    if (!canSee(who, claim)) throw notFound("The item");
    return { item, claim };
  }

  async function updateItem(who: Actor, id: string, raw: unknown) {
    const { item, claim } = mustItem(who, id);
    ownDraft(who, claim);
    const d = readItem(who, { id: claim.owner_id, email: claim.owner_email }, raw, item);
    // A changed amount, currency or date needs the rate again; otherwise the one it has stays.
    const same = d.rate_source === "pending" && item.rate_source === "tcmb" && d.currency === item.currency && d.date === item.date;
    const rate = same ? { rate_micro: item.rate_micro, rate_day: item.rate_day } : await withRate(d);
    if (same) Object.assign(d, { rate_source: "tcmb", amount_try: toKurus(d.amount, d.currency, item.rate_micro!) });
    ownDraft(who, mustClaim(claim.id));
    saveItem(claim.id, d, rate, item.id);
    return itemOut(one<ItemRow>("SELECT * FROM items WHERE id = ?", item.id)!);
  }

  function removeItem(who: Actor, id: string) {
    const { item, claim } = mustItem(who, id);
    ownDraft(who, claim);
    tx(() => {
      if (item.card_tx_id) run("UPDATE card_transactions SET item_id = NULL WHERE id = ?", item.card_tx_id);
      run("DELETE FROM items WHERE id = ?", item.id);
      refresh(claim.id);
    });
  }

  /** Links a draft receipt item to the holder's card purchase with the same amount within cards.match_days. */
  function matchCard(itemId: string): boolean {
    const i = one<ItemRow & { owner_email: string; state: string }>(
      "SELECT i.*, c.owner_email, c.state FROM items i JOIN claims c ON c.id = i.claim_id WHERE i.id = ?",
      itemId,
    );
    if (!i || i.state !== "draft" || i.card_tx_id || i.kind !== "receipt") return false;
    const m = cfg().cards.matchDays;
    const from = new Date(Date.parse(`${i.date}T00:00:00Z`) - m * DAY).toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${i.date}T00:00:00Z`) + m * DAY).toISOString().slice(0, 10);
    const t = one<CardTx>(
      `SELECT * FROM card_transactions WHERE holder_email = ? AND item_id IS NULL AND date BETWEEN ? AND ?
         AND ((currency = ? AND amount = ?) OR (? = 'TRY' AND amount_try = ?) OR (amount_try = ?))
       ORDER BY ABS(julianday(date) - julianday(?)), created_at LIMIT 1`,
      i.owner_email,
      from,
      to,
      i.currency,
      i.amount,
      i.currency,
      i.amount,
      i.amount_try ?? -1,
      i.date,
    );
    if (!t) return false;
    tx(() => {
      run(
        "UPDATE items SET card_tx_id = ?, paid_by = 'company', amount_try = ?, rate_source = 'card', rate_micro = NULL, rate_day = NULL, updated_at = ? WHERE id = ?",
        t.id,
        t.amount_try,
        iso(),
        i.id,
      );
      run("UPDATE card_transactions SET item_id = ? WHERE id = ?", i.id, t.id);
      refresh(i.claim_id);
    });
    return true;
  }

  /** Items whose TCMB rate could not be fetched, tried again. */
  async function retryRates(): Promise<void> {
    if (!config) return;
    for (const i of q<ItemRow>("SELECT * FROM items WHERE rate_source = 'pending' LIMIT 50")) {
      const d = { rate_source: "pending", currency: i.currency, date: i.date, amount: i.amount, amount_try: null } as Draft;
      const r = await withRate(d).catch(() => null);
      if (!r || d.rate_source !== "tcmb") {
        if (links.tcmb.error) return;
        continue;
      }
      tx(() => {
        run(
          "UPDATE items SET rate_source = 'tcmb', rate_micro = ?, rate_day = ?, amount_try = ?, updated_at = ? WHERE id = ? AND rate_source = 'pending'",
          r.rate_micro,
          r.rate_day,
          d.amount_try,
          iso(),
          i.id,
        );
        refresh(i.claim_id);
      });
    }
  }

  // ------------------------------------------------------------------ the policy on a claim

  function policyItems(c: ClaimRow): PolicyItem[] {
    const items = q<ItemRow>("SELECT * FROM items WHERE claim_id = ? ORDER BY date, position", c.id);
    return items.map((i) => {
      const lookalikes: PolicyItem["lookalikes"] = [];
      if (i.kind === "receipt" && i.seller_key)
        for (const o of q<{ id: string; number: string }>(
          `SELECT o.id, oc.number FROM items o JOIN claims oc ON oc.id = o.claim_id
           WHERE o.seller_key = ? AND o.date = ? AND o.amount = ? AND o.currency = ? AND o.id != ? AND oc.state != 'rejected'
             AND o.rowid < (SELECT rowid FROM items WHERE id = ?) LIMIT 3`,
          i.seller_key,
          i.date,
          i.amount,
          i.currency,
          i.id,
          i.id,
        ))
          lookalikes.push({ claim: o.number, item: o.id, sameFile: false });
      if (i.receipt_id)
        for (const o of q<{ id: string; number: string }>(
          `SELECT o.id, oc.number FROM items o JOIN claims oc ON oc.id = o.claim_id JOIN receipts r ON r.id = o.receipt_id
           WHERE r.sha256 = (SELECT sha256 FROM receipts WHERE id = ?) AND o.claim_id != ? AND oc.state != 'rejected'
             AND o.rowid < (SELECT rowid FROM items WHERE id = ?) LIMIT 3`,
          i.receipt_id,
          c.id,
          i.id,
        ))
          if (!lookalikes.some((l) => l.item === o.id)) lookalikes.push({ claim: o.number, item: o.id, sameFile: true });
      const differs: string[] = [];
      const r = i.receipt_id ? one<ReceiptRow>("SELECT read_state, read_fields FROM receipts WHERE id = ?", i.receipt_id) : undefined;
      if (r?.read_state === "read" && r.read_fields) {
        const f = JSON.parse(r.read_fields) as ReadFields;
        if (f.amount !== null && (f.currency ?? "TRY") === i.currency && f.amount !== i.amount) differs.push("amount");
        if (f.date && f.date !== i.date) differs.push("date");
      }
      return {
        id: i.id,
        kind: i.kind,
        category: i.category,
        project: i.project,
        date: i.date,
        amountTry: i.amount_try,
        paidBy: i.paid_by,
        hasReceipt: !!i.receipt_id,
        noReceiptReason: i.no_receipt_reason,
        lookalikes,
        differs,
      };
    });
  }

  /** What the person spent in their other sent claims, by category and day or month. */
  function usageFor(c: ClaimRow) {
    const rows = q<{ category: string; date: string; total: number }>(
      `SELECT i.category, i.date, SUM(COALESCE(i.amount_try, 0)) AS total FROM items i JOIN claims c ON c.id = i.claim_id
       WHERE c.owner_id = ? AND c.id != ? AND c.state IN ('submitted', 'approved', 'paid') GROUP BY i.category, i.date`,
      c.owner_id,
      c.id,
    );
    const byDay = new Map<string, number>();
    const byMonth = new Map<string, number>();
    for (const r of rows) {
      byDay.set(`${r.category}|${r.date}`, (byDay.get(`${r.category}|${r.date}`) ?? 0) + r.total);
      byMonth.set(`${r.category}|${r.date.slice(0, 7)}`, (byMonth.get(`${r.category}|${r.date.slice(0, 7)}`) ?? 0) + r.total);
    }
    return { day: (cat: string, d: string) => byDay.get(`${cat}|${d}`) ?? 0, month: (cat: string, m: string) => byMonth.get(`${cat}|${m}`) ?? 0 };
  }

  /** Works out a draft claim's flags and totals again. A sent claim keeps the flags it was sent with. */
  function refresh(claimId: string) {
    const c = one<ClaimRow>("SELECT * FROM claims WHERE id = ?", claimId);
    if (!c) return;
    if (c.state === "draft" && config) {
      const checked = checkItems(config, policyItems(c), usageFor(c), today());
      for (const [id, r] of checked) run("UPDATE items SET flags = ?, held = ? WHERE id = ?", JSON.stringify(r.flags), r.held, id);
    }
    const t = one<{ total: number; reimbursable: number }>(
      `SELECT COALESCE(SUM(COALESCE(amount_try, 0)), 0) AS total,
              COALESCE(SUM(CASE WHEN paid_by = 'employee' THEN COALESCE(amount_try, 0) - held ELSE 0 END), 0) AS reimbursable
       FROM items WHERE claim_id = ?`,
      claimId,
    )!;
    run("UPDATE claims SET total = ?, reimbursable = ?, updated_at = ? WHERE id = ?", t.total, t.reimbursable, iso(), claimId);
  }

  // ------------------------------------------------------------------ claims

  function stepOut(s: StepRow) {
    const m = s.approver_email ? memberByEmail(s.approver_email) : undefined;
    return {
      id: s.id,
      position: s.position,
      kind: s.kind,
      approver: s.approver_email ? { email: s.approver_email, name: m?.name ?? person(s.approver_email)?.name ?? null, member: !!m } : null,
      why: s.why,
      state: s.state,
      by: s.by_id ? { id: s.by_id, name: s.by_name ?? "" } : null,
      at: s.at,
      comment: s.comment,
    };
  }

  const stepsOf = (c: ClaimRow) => q<StepRow>("SELECT * FROM steps WHERE claim_id = ? AND round = ? ORDER BY position", c.id, c.round);
  const pendingStep = (c: ClaimRow) =>
    c.state === "submitted" ? one<StepRow>("SELECT * FROM steps WHERE claim_id = ? AND round = ? AND state = 'pending'", c.id, c.round) : undefined;

  /** Whether `who` may decide the claim's pending step. A finance step is never the claimant's or an earlier approver's. */
  function mayDecide(who: Actor, c: ClaimRow, s: StepRow | undefined): boolean {
    if (!s || c.owner_id === who.id) return false;
    if (s.kind !== "finance") return !!who.email && s.approver_email === who.email.toLowerCase();
    if (!isFinance(who)) return false;
    return !one("SELECT 1 FROM steps WHERE claim_id = ? AND round = ? AND state = 'approved' AND by_id = ?", c.id, c.round, who.id);
  }

  function claimOut(c: ClaimRow, who: Actor, full = false) {
    const steps = stepsOf(c);
    const pending = steps.find((s) => s.state === "pending");
    const flags = q<{ flags: string }>("SELECT flags FROM items WHERE claim_id = ?", c.id).flatMap((r) => JSON.parse(r.flags) as Flag[]);
    const company = one<{ n: number }>("SELECT COALESCE(SUM(COALESCE(amount_try, 0)), 0) AS n FROM items WHERE claim_id = ? AND paid_by = 'company'", c.id)!.n;
    const held = one<{ n: number }>("SELECT COALESCE(SUM(held), 0) AS n FROM items WHERE claim_id = ?", c.id)!.n;
    const batch = c.batch_id ? one<BatchRow>("SELECT * FROM batches WHERE id = ?", c.batch_id) : undefined;
    const n = one<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE claim_id = ?", c.id)!.n;
    const base = {
      id: c.id,
      number: c.number,
      title: c.title,
      state: c.state,
      owner: { id: c.owner_id, name: c.owner_name, email: c.owner_email },
      department: c.department ? { id: c.department, name: departmentName(c.department)! } : null,
      currency: "TRY" as const,
      total: c.total,
      reimbursable: c.reimbursable,
      companyPaid: company,
      held,
      items: n,
      flags: { count: flags.length, finance: flags.filter((f) => f.finance).length, blocking: flags.filter((f) => f.blocks).length },
      pending: pending ? stepOut(pending) : null,
      batch: batch ? { id: batch.id, number: batch.number, method: batch.method, state: batch.state, payDate: batch.pay_date } : null,
      submittedAt: c.submitted_at,
      decidedAt: c.decided_at,
      paidAt: c.paid_at,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      canEdit: c.state === "draft" && c.owner_id === who.id,
      canDecide: mayDecide(who, c, pending),
    };
    if (!full) return base;
    const lines = q<ItemRow>("SELECT * FROM items WHERE claim_id = ? ORDER BY date, position", c.id).map(itemOut);
    const blocks =
      c.state === "draft" && config
        ? [...claimBlocks(config, policyItems(c)), ...lines.flatMap((i) => i.flags.filter((f) => f.blocks).map((f) => `${i.date}: ${f.text}`))]
        : [];
    return {
      ...base,
      lines,
      steps: steps.map(stepOut),
      blocks,
      history: q<{ at: string; by_id: string | null; by_name: string; action: string; text: string | null }>(
        "SELECT at, by_id, by_name, action, text FROM events WHERE claim_id = ? ORDER BY id",
        c.id,
      ).map((e) => ({ at: e.at, by: { id: e.by_id, name: e.by_name }, action: e.action, text: e.text })),
    };
  }
  type ClaimFull = Extract<ReturnType<typeof claimOut>, { lines: unknown }>;

  const event = (claimId: string, who: Actor | null, action: string, t: string | null = null) =>
    run(
      "INSERT INTO events (claim_id, at, by_id, by_name, action, text) VALUES (?, ?, ?, ?, ?, ?)",
      claimId,
      iso(),
      who?.id ?? null,
      who?.name ?? "Expenses",
      action,
      t,
    );

  function listClaims(who: Actor, query: URLSearchParams) {
    const scope = query.get("scope") ?? "mine";
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (scope === "mine") {
      where.push("c.owner_id = ?");
      args.push(who.id);
    } else if (scope === "approvals") {
      // Claims waiting for the caller: steps that name them, and finance steps when they are finance.
      const e = (who.email ?? "").toLowerCase();
      where.push(
        `c.state = 'submitted' AND c.owner_id != ? AND EXISTS (SELECT 1 FROM steps s WHERE s.claim_id = c.id AND s.round = c.round AND s.state = 'pending'
           AND (s.approver_email = ? OR (s.kind = 'finance' AND ? = 1 AND NOT EXISTS (SELECT 1 FROM steps p WHERE p.claim_id = c.id AND p.round = c.round AND p.state = 'approved' AND p.by_id = ?))))`,
      );
      args.push(who.id, e, isFinance(who) ? 1 : 0, who.id);
    } else if (scope === "decided") {
      where.push("EXISTS (SELECT 1 FROM steps s WHERE s.claim_id = c.id AND s.by_id = ?)");
      args.push(who.id);
    } else if (scope === "all") {
      if (!atLeast(who.role, "viewer")) throw forbidden("scope=all needs the viewer role; scope=mine and scope=approvals are yours.");
    } else throw bad("scope is mine, approvals, decided or all.");
    const state = query.get("state");
    if (state) {
      const states = state.split(",");
      if (states.some((s) => !(CLAIM_STATES as readonly string[]).includes(s))) throw bad(`state is one or more of ${CLAIM_STATES.join(", ")}.`);
      where.push(`c.state IN (${states.map(() => "?").join(", ")})`);
      args.push(...states);
    }
    const dept = query.get("department");
    if (dept) {
      where.push("c.department = ?");
      args.push(dept);
    }
    const ownerQ = query.get("person");
    if (ownerQ) {
      where.push("c.owner_email = ?");
      args.push(ownerQ.toLowerCase());
    }
    const qt = query.get("q")?.trim();
    if (qt) {
      where.push("(c.title LIKE ? OR c.number LIKE ? OR c.owner_name LIKE ?)");
      args.push(`%${qt}%`, `%${qt}%`, `%${qt}%`);
    }
    const rows = q<ClaimRow>(
      `SELECT c.* FROM claims c ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(c.submitted_at, c.created_at) DESC LIMIT 500`,
      ...args,
    );
    return rows.map((c) => claimOut(c, who));
  }

  function createClaim(who: Actor, raw: unknown) {
    const e = mustPerson(who);
    const b = body(raw, ["title"]);
    const title = text(b.title ?? "", "title", 120);
    const p = person(e);
    const id = randomUUID();
    tx(() => {
      run(
        `INSERT INTO claims (id, number, owner_id, owner_name, owner_email, department, title, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        id,
        nextNumber("EXP", 4),
        who.id,
        who.name,
        e,
        p?.department ?? null,
        title,
        iso(),
        iso(),
      );
      event(id, who, "created");
    });
    return claimOut(mustClaim(id), who, true) as ClaimFull;
  }

  const getClaim = (who: Actor, id: string) => claimOut(seeClaim(who, id), who, true) as ClaimFull;

  function updateClaim(who: Actor, id: string, raw: unknown) {
    const c = seeClaim(who, id);
    ownDraft(who, c);
    const b = body(raw, ["title"]);
    if (b.title !== undefined) run("UPDATE claims SET title = ?, updated_at = ? WHERE id = ?", text(b.title, "title", 120), iso(), c.id);
    return getClaim(who, c.id);
  }

  function removeClaim(who: Actor, id: string) {
    const c = seeClaim(who, id);
    ownDraft(who, c);
    if (c.round > 0) throw conflict("The claim was sent before and keeps its history; it stays as a draft.");
    tx(() => {
      run("UPDATE card_transactions SET item_id = NULL WHERE item_id IN (SELECT id FROM items WHERE claim_id = ?)", c.id);
      run("DELETE FROM claims WHERE id = ?", c.id);
    });
  }

  function submit(who: Actor, id: string) {
    const c = seeClaim(who, id);
    ownDraft(who, c);
    const conf = cfg();
    const blocks = tx(() => {
      refresh(c.id);
      const items = policyItems(c);
      const flags = q<ItemRow>("SELECT * FROM items WHERE claim_id = ?", c.id).flatMap(flagsOf);
      return [...claimBlocks(conf, items), ...flags.filter((f) => f.blocks).map((f) => f.text)];
    });
    if (blocks.length) throw conflict(`The claim cannot be sent: ${blocks.join(" ")}`);
    return tx(() => {
      const now = mustClaim(c.id);
      const p = person(now.owner_email);
      const flags = q<ItemRow>("SELECT * FROM items WHERE claim_id = ?", c.id).flatMap(flagsOf);
      const reasons = [...new Set(flags.filter((f) => f.finance).map((f) => f.code))].map(
        (code) =>
          ({
            "over-limit": "over a limit",
            "no-receipt": "an item without a receipt",
            duplicate: "a possible duplicate",
            "same-file": "a receipt file used before",
            late: "a late receipt",
            "receipt-differs": "a receipt that reads otherwise",
          })[code],
      );
      const plan = planChain(conf, { ownerEmail: now.owner_email, department: p?.department ?? null, total: now.total }, p?.manager_email ?? null, reasons);
      const round = now.round + 1;
      plan.forEach((s, i) =>
        run(
          "INSERT INTO steps (id, claim_id, round, position, kind, approver_email, why, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          randomUUID(),
          c.id,
          round,
          i + 1,
          s.kind,
          s.approver,
          s.why,
          i === 0 ? "pending" : "waiting",
        ),
      );
      run(
        "UPDATE claims SET state = 'submitted', round = ?, department = ?, submitted_at = ?, decided_at = NULL, updated_at = ? WHERE id = ?",
        round,
        p?.department ?? null,
        iso(),
        iso(),
        c.id,
      );
      event(c.id, who, "submitted", plan.map((s) => s.approver ?? "finance").join(" > "));
      return getClaim(who, c.id);
    });
  }

  function withdraw(who: Actor, id: string) {
    const c = seeClaim(who, id);
    if (c.owner_id !== who.id) throw forbidden(`This claim is ${c.owner_name}'s; only they withdraw it.`);
    if (c.state !== "submitted") throw conflict(`The claim is ${c.state}; only a claim waiting for approval is withdrawn.`);
    return tx(() => {
      run("UPDATE steps SET state = 'cancelled' WHERE claim_id = ? AND round = ? AND state IN ('pending', 'waiting')", c.id, c.round);
      run("UPDATE claims SET state = 'draft', updated_at = ? WHERE id = ?", iso(), c.id);
      event(c.id, who, "withdrawn");
      refresh(c.id);
      return getClaim(who, c.id);
    });
  }

  function decide(who: Actor, id: string, raw: unknown, decision: "approve" | "reject" | "return") {
    const c = seeClaim(who, id);
    const b = body(raw, ["comment"]);
    const comment = optText(b.comment, "comment", 1000) ?? null;
    if (decision !== "approve" && !comment) throw bad(`comment says why the claim is ${decision === "reject" ? "rejected" : "sent back"}.`);
    return tx(() => {
      const now = mustClaim(c.id);
      if (now.state !== "submitted") throw conflict(`The claim is ${now.state}; there is nothing to decide.`);
      const s = pendingStep(now)!;
      if (!mayDecide(who, now, s))
        throw forbidden(
          now.owner_id === who.id
            ? "Nobody approves their own claim."
            : s.kind === "finance"
              ? "This step is finance's: a member with the editor role who has not approved this claim already."
              : `This step is ${s.approver_email}'s.`,
        );
      const state = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "returned";
      run("UPDATE steps SET state = ?, by_id = ?, by_name = ?, at = ?, comment = ? WHERE id = ?", state, who.id, who.name, iso(), comment, s.id);
      count(counters.decisions, state);
      if (decision === "approve") {
        const next = one<StepRow>("SELECT * FROM steps WHERE claim_id = ? AND round = ? AND state = 'waiting' ORDER BY position LIMIT 1", now.id, now.round);
        if (next) {
          run("UPDATE steps SET state = 'pending' WHERE id = ?", next.id);
          event(now.id, who, "approved", comment);
        } else if (now.reimbursable > 0) {
          run("UPDATE claims SET state = 'approved', decided_at = ?, updated_at = ? WHERE id = ?", iso(), iso(), now.id);
          event(now.id, who, "approved", comment);
        } else {
          // A claim the company card paid in full has nothing to pay back.
          run("UPDATE claims SET state = 'paid', decided_at = ?, paid_at = ?, updated_at = ? WHERE id = ?", iso(), iso(), iso(), now.id);
          event(now.id, who, "approved", comment);
          event(now.id, null, "paid", "Nothing to pay back: the company paid it all.");
        }
      } else {
        run("UPDATE steps SET state = 'cancelled' WHERE claim_id = ? AND round = ? AND state = 'waiting'", now.id, now.round);
        run("UPDATE claims SET state = ?, decided_at = ?, updated_at = ? WHERE id = ?", decision === "reject" ? "rejected" : "draft", iso(), iso(), now.id);
        event(now.id, who, decision === "reject" ? "rejected" : "returned", comment);
        if (decision === "return") refresh(now.id);
      }
      return getClaim(who, now.id);
    });
  }

  /** Finance passes the waiting step to another member: a manager away, or one who is not a member here. */
  function reassign(who: Actor, id: string, raw: unknown) {
    if (!isFinance(who)) throw forbidden("Passing a step to someone else needs the editor role.");
    const c = seeClaim(who, id);
    const b = body(raw, ["to", "comment"]);
    const to = emailOf(b.to, "to");
    const comment = optText(b.comment, "comment", 1000) ?? null;
    return tx(() => {
      const now = mustClaim(c.id);
      const s = pendingStep(now);
      if (!s) throw conflict(`The claim is ${now.state}; no step is waiting.`);
      if (to === now.owner_email) throw bad("to: nobody approves their own claim.");
      if (!memberByEmail(to)) throw bad(`to: ${to} is not a member of Expenses.`);
      if (one("SELECT 1 FROM steps WHERE claim_id = ? AND round = ? AND state = 'approved' AND approver_email = ?", now.id, now.round, to))
        throw bad(`to: ${to} approved this claim already.`);
      run("UPDATE steps SET kind = 'member', approver_email = ?, why = ? WHERE id = ?", to, `${s.why} Passed to ${to} by ${who.name}.`, s.id);
      event(now.id, who, "reassigned", `${s.approver_email ?? "finance"} > ${to}${comment ? `: ${comment}` : ""}`);
      return getClaim(who, now.id);
    });
  }

  // ------------------------------------------------------------------ the caller

  function me(who: Actor) {
    const e = who.email?.toLowerCase() ?? null;
    const p = e ? person(e) : undefined;
    const iban = e ? one<{ iban: string }>("SELECT iban FROM payees WHERE email = ?", e)?.iban : undefined;
    return {
      member: { id: who.id, name: who.name, email: e, role: who.role },
      person: p
        ? {
            employeeId: p.employee_id,
            department: p.department ? { id: p.department, name: departmentName(p.department)! } : null,
            manager: p.manager_email,
            source: p.source,
          }
        : null,
      iban: iban ? `${iban.slice(0, 4)} **** ${iban.slice(-4)}` : null,
    };
  }

  function setIban(who: Actor, raw: unknown) {
    const e = mustPerson(who);
    const b = body(raw, ["iban"]);
    if (b.iban === null) run("DELETE FROM payees WHERE email = ?", e);
    else {
      const v = typeof b.iban === "string" ? checkIban(b.iban) : null;
      if (!v) throw bad("iban is an IBAN, such as TR33 0006 1005 1978 6457 8413 26; its check digits must add up.");
      run(
        "INSERT INTO payees (email, iban, updated_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET iban = excluded.iban, updated_at = excluded.updated_at",
        e,
        v,
        iso(),
      );
    }
    return me(who);
  }

  function summary(who: Actor) {
    const e = (who.email ?? "").toLowerCase();
    const mine = (state: string) =>
      one<{ n: number; t: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(reimbursable), 0) AS t FROM claims WHERE owner_id = ? AND state = ?", who.id, state)!;
    const out = {
      drafts: mine("draft").n,
      submitted: mine("submitted").n,
      toApprove: listClaims(who, new URLSearchParams({ scope: "approvals" })).length,
      owed: mine("approved").t,
      unmatchedCard: e ? one<{ n: number }>("SELECT COUNT(*) AS n FROM card_transactions WHERE holder_email = ? AND item_id IS NULL", e)!.n : 0,
      finance: null as null | {
        waiting: number;
        approvedUnpaid: number;
        approvedTotal: number;
        openBatches: number;
        unmatchedCard: number;
        ratesPending: number;
      },
    };
    if (atLeast(who.role, "viewer"))
      out.finance = {
        waiting: one<{ n: number }>("SELECT COUNT(*) AS n FROM claims WHERE state = 'submitted'")!.n,
        approvedUnpaid: one<{ n: number }>("SELECT COUNT(*) AS n FROM claims WHERE state = 'approved' AND batch_id IS NULL")!.n,
        approvedTotal: one<{ n: number }>("SELECT COALESCE(SUM(reimbursable), 0) AS n FROM claims WHERE state = 'approved'")!.n,
        openBatches: one<{ n: number }>("SELECT COUNT(*) AS n FROM batches WHERE state != 'paid'")!.n,
        unmatchedCard: one<{ n: number }>("SELECT COUNT(*) AS n FROM card_transactions WHERE item_id IS NULL")!.n,
        ratesPending: one<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE rate_source = 'pending'")!.n,
      };
    return out;
  }

  async function rateQuote(query: URLSearchParams) {
    const c = cfg();
    const currency = (query.get("currency") ?? "").toUpperCase();
    if (!knownCurrency(currency) || currency === "TRY") throw bad("currency is a code other than TRY, such as EUR.");
    if (c.currencies && !c.currencies.includes(currency)) throw bad(`currency: ${currency} is not taken; the file takes ${c.currencies.join(", ")}.`);
    const date = query.get("date") ?? today();
    day(date, "date");
    if (date > today()) throw bad(`date: ${date} is after today.`);
    try {
      const r = await rates.rateFor(currency, date, c.rates.kind, c.rates.day, c.rates.url, today());
      linkOk("tcmb");
      return { currency, date, use: c.rates.kind, day: r.day, rate: rateText(r.micro), micro: r.micro };
    } catch (err) {
      if (err instanceof LinkError) {
        linkFailed("tcmb", err);
        throw new ExpensesError(502, "link-failed", err.message);
      }
      throw bad(`currency: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ batches

  function batchLines(b: BatchRow) {
    const claims = q<ClaimRow>("SELECT * FROM claims WHERE batch_id = ? ORDER BY owner_name COLLATE NOCASE, number", b.id);
    const byPerson = new Map<string, { claims: ClaimRow[]; amount: number }>();
    for (const c of claims) {
      const g = byPerson.get(c.owner_email) ?? { claims: [], amount: 0 };
      g.claims.push(c);
      g.amount += c.reimbursable;
      byPerson.set(c.owner_email, g);
    }
    return [...byPerson].map(([e, g]) => {
      const p = one<PersonRow>("SELECT * FROM people WHERE email = ?", e);
      const iban = one<{ iban: string }>("SELECT iban FROM payees WHERE email = ?", e)?.iban ?? null;
      const cats = q<{ category: string; project: string | null; amount: number }>(
        `SELECT category, project, SUM(COALESCE(amount_try, 0) - held) AS amount FROM items
         WHERE paid_by = 'employee' AND claim_id IN (${g.claims.map(() => "?").join(", ")}) GROUP BY category, project ORDER BY category, project`,
        ...g.claims.map((c) => c.id),
      );
      return {
        person: { email: e, name: g.claims[0]!.owner_name, employeeId: p?.employee_id ?? null },
        iban,
        amount: g.amount,
        claims: g.claims.map((c) => ({ id: c.id, number: c.number, title: c.title, amount: c.reimbursable })),
        lines: cats.map((x) => {
          const cat = config?.categories.find((k) => k.id === x.category);
          return { category: x.category, name: cat?.name ?? x.category, account: cat?.account ?? null, project: x.project, amount: x.amount };
        }),
      };
    });
  }

  function batchOut(b: BatchRow, full = false) {
    const lines = batchLines(b);
    const base = {
      id: b.id,
      number: b.number,
      method: b.method,
      state: b.state,
      payDate: b.pay_date,
      currency: "TRY" as const,
      total: b.total,
      people: lines.length,
      claims: lines.reduce((s, l) => s + l.claims.length, 0),
      missingIban: b.method === "transfer" ? lines.filter((l) => !l.iban).map((l) => l.person.email) : [],
      createdBy: b.created_by,
      createdAt: b.created_at,
      sentAt: b.sent_at,
      paidAt: b.paid_at,
      paidBy: b.paid_by,
    };
    return full ? { ...base, lines: lines.map((l) => ({ ...l, iban: l.iban ? `${l.iban.slice(0, 4)} **** ${l.iban.slice(-4)}` : null })) } : base;
  }
  type BatchFull = Extract<ReturnType<typeof batchOut>, { lines: unknown }>;

  function mustBatch(id: string): BatchRow {
    const b = one<BatchRow>("SELECT * FROM batches WHERE id = ? OR number = ?", id, id);
    if (!b) throw notFound("The batch");
    return b;
  }

  const batchTotal = (id: string) =>
    run("UPDATE batches SET total = (SELECT COALESCE(SUM(reimbursable), 0) FROM claims WHERE batch_id = ?) WHERE id = ?", id, id);

  function addToBatch(b: BatchRow, ids: string[]) {
    for (const id of ids) {
      const c = mustClaim(id);
      if (c.state !== "approved") throw conflict(`${c.number} is ${c.state}; only approved claims are paid.`);
      if (c.batch_id && c.batch_id !== b.id) throw conflict(`${c.number} is in another batch.`);
      if (c.reimbursable <= 0) throw conflict(`${c.number} has nothing to pay back.`);
      run("UPDATE claims SET batch_id = ?, updated_at = ? WHERE id = ?", b.id, iso(), c.id);
    }
  }

  function listBatches(query: URLSearchParams) {
    const state = query.get("state");
    if (state && !["open", "sent", "paid"].includes(state)) throw bad("state is open, sent or paid.");
    return q<BatchRow>(`SELECT * FROM batches ${state ? "WHERE state = ?" : ""} ORDER BY created_at DESC LIMIT 200`, ...(state ? [state] : [])).map((b) =>
      batchOut(b),
    );
  }

  function createBatch(who: Actor, raw: unknown) {
    if (!isFinance(who)) throw forbidden("Paying claims needs the editor role.");
    const b = body(raw, ["method", "payDate", "claims"]);
    if (b.method !== "payroll" && b.method !== "transfer") throw bad("method is payroll (paid with pay) or transfer (a bank transfer list).");
    const payDate = b.payDate === undefined ? today() : day(b.payDate, "payDate");
    let ids: string[];
    if (b.claims === undefined)
      ids = q<{ id: string }>("SELECT id FROM claims WHERE state = 'approved' AND batch_id IS NULL AND reimbursable > 0").map((r) => r.id);
    else if (!Array.isArray(b.claims) || b.claims.some((x) => typeof x !== "string") || b.claims.length > 2000)
      throw bad("claims is a list of claim ids or numbers.");
    else ids = b.claims as string[];
    if (!ids.length) throw conflict("No approved claim is waiting to be paid.");
    return tx(() => {
      const id = randomUUID();
      run(
        "INSERT INTO batches (id, number, method, state, pay_date, created_by, created_at) VALUES (?, ?, ?, 'open', ?, ?, ?)",
        id,
        nextNumber("PAY", 3),
        b.method as string,
        payDate,
        who.name,
        iso(),
      );
      const batch = mustBatch(id);
      addToBatch(batch, ids);
      batchTotal(id);
      return batchOut(mustBatch(id), true) as BatchFull;
    });
  }

  const getBatch = (id: string) => batchOut(mustBatch(id), true) as BatchFull;

  function updateBatch(who: Actor, id: string, raw: unknown) {
    if (!isFinance(who)) throw forbidden("Paying claims needs the editor role.");
    const b = body(raw, ["payDate", "add", "remove"]);
    return tx(() => {
      const batch = mustBatch(id);
      if (batch.state !== "open") throw conflict(`The batch is ${batch.state}; only an open batch changes.`);
      const list = (v: unknown, f: string) => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad(`${f} is a list of claim ids or numbers.`);
        return v as string[];
      };
      if (b.payDate !== undefined) run("UPDATE batches SET pay_date = ? WHERE id = ?", day(b.payDate, "payDate"), batch.id);
      addToBatch(batch, list(b.add, "add"));
      for (const cid of list(b.remove, "remove")) {
        const c = mustClaim(cid);
        if (c.batch_id !== batch.id) throw bad(`remove: ${c.number} is not in this batch.`);
        run("UPDATE claims SET batch_id = NULL, updated_at = ? WHERE id = ?", iso(), c.id);
      }
      batchTotal(batch.id);
      return getBatch(batch.id);
    });
  }

  function removeBatch(who: Actor, id: string) {
    if (!isFinance(who)) throw forbidden("Paying claims needs the editor role.");
    tx(() => {
      const batch = mustBatch(id);
      if (batch.state !== "open") throw conflict(`The batch is ${batch.state}; only an open batch is removed.`);
      run("UPDATE claims SET batch_id = NULL WHERE batch_id = ?", batch.id);
      run("DELETE FROM batches WHERE id = ?", batch.id);
    });
  }

  function sendBatch(who: Actor, id: string) {
    if (!isFinance(who)) throw forbidden("Paying claims needs the editor role.");
    return tx(() => {
      const batch = mustBatch(id);
      if (batch.state !== "open") throw conflict(`The batch is ${batch.state} already.`);
      const out = batchOut(batch);
      if (!out.claims) throw conflict("The batch has no claims.");
      if (out.missingIban.length) throw conflict(`No IBAN for ${out.missingIban.join(", ")}: they add it under their account, or pay them with pay.`);
      run("UPDATE batches SET state = 'sent', sent_at = ? WHERE id = ?", iso(), batch.id);
      for (const c of q<{ id: string }>("SELECT id FROM claims WHERE batch_id = ?", batch.id))
        event(c.id, who, "in payment", `${batch.number}, ${batch.method}`);
      return getBatch(batch.id);
    });
  }

  function paidBatch(who: Actor, id: string, raw: unknown) {
    if (!isFinance(who)) throw forbidden("Marking a batch paid needs the editor role.");
    const b = body(raw, ["paidOn"]);
    const paidOn = b.paidOn === undefined ? null : day(b.paidOn, "paidOn");
    return tx(() => {
      const batch = mustBatch(id);
      if (batch.state === "paid") return getBatch(batch.id);
      if (batch.state !== "sent") throw conflict("The batch is open; send it before it is paid.");
      const at = paidOn ? `${paidOn}T12:00:00.000Z` : iso();
      run("UPDATE batches SET state = 'paid', paid_at = ?, paid_by = ? WHERE id = ?", at, who.name, batch.id);
      for (const c of q<{ id: string }>("SELECT id FROM claims WHERE batch_id = ?", batch.id)) {
        run("UPDATE claims SET state = 'paid', paid_at = ?, updated_at = ? WHERE id = ?", at, iso(), c.id);
        event(c.id, who, "paid", batch.number);
      }
      return getBatch(batch.id);
    });
  }

  /** The bank transfer list, with full IBANs: name, IBAN, amount, currency, what it is for. */
  function transfers(who: Actor, id: string): { filename: string; rows: Array<Array<string | number | null>> } {
    if (!isFinance(who)) throw forbidden("The transfer list holds IBANs; it needs the editor role.");
    const batch = mustBatch(id);
    if (batch.method !== "transfer") throw conflict("This batch is paid with pay; Payroll takes it from GET /api/v1/payroll.");
    const sep = cfg().exports.decimal;
    const rows: Array<Array<string | number | null>> = [["name", "iban", "amount", "currency", "description"]];
    for (const l of batchLines(batch))
      rows.push([l.person.name, l.iban, decimalText(l.amount, "TRY", sep), "TRY", `${batch.number} ${l.claims.map((c) => c.number).join(" ")}`.slice(0, 140)]);
    return { filename: `${batch.number}-transfers.csv`, rows };
  }

  /** What Payroll takes: payroll batches sent or paid with a pay date in the month, per person. */
  function payroll(query: URLSearchParams) {
    const month = query.get("month") ?? today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad("month is YYYY-MM.");
    const batches = q<BatchRow>(
      "SELECT * FROM batches WHERE method = 'payroll' AND state IN ('sent', 'paid') AND substr(pay_date, 1, 7) = ? ORDER BY pay_date, number",
      month,
    );
    return {
      month,
      currency: "TRY" as const,
      batches: batches.map((b) => ({
        id: b.id,
        number: b.number,
        state: b.state,
        payDate: b.pay_date,
        total: b.total,
        people: batchLines(b).map(({ person: p, amount, claims, lines }) => ({ ...p, amount, claims, lines })),
      })),
    };
  }

  // ------------------------------------------------------------------ the background

  let ticking = false;
  async function tick() {
    if (ticking || !config) return;
    ticking = true;
    try {
      const now = clock();
      if (hr && now - lastHrSync >= (config.hr?.everyMinutes ?? 15) * MINUTE) {
        lastHrSync = now;
        await syncHr();
      }
      if (time && now - lastTimeSync >= (config.time?.everyMinutes ?? 15) * MINUTE) {
        lastTimeSync = now;
        await syncTime();
      }
      await readReceipts();
      await retryRates();
    } catch (err) {
      log("error", "background work failed", { error: String(err) });
    } finally {
      ticking = false;
    }
  }

  function integrations() {
    const c = config;
    const state = (k: keyof typeof links, on: boolean, extra: Record<string, unknown> = {}) => ({ configured: on, ...links[k], ...extra });
    return {
      hr: state("hr", !!c?.hr, {
        url: c?.hr?.url ?? null,
        people: one<{ n: number }>("SELECT COUNT(*) AS n FROM people WHERE source = 'hr' AND active = 1")!.n,
      }),
      time: state("time", !!c?.time, {
        url: c?.time?.url ?? null,
        projects: one<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE source = 'time' AND active = 1")!.n,
      }),
      reader: state("reader", !!c?.receipts.reader, {
        url: c?.receipts.reader?.url ?? null,
        waiting: one<{ n: number }>("SELECT COUNT(*) AS n FROM receipts WHERE read_state = 'pending'")!.n,
      }),
      tcmb: state("tcmb", true, {
        url: c?.rates.url ?? null,
        lastDay: one<{ d: string | null }>("SELECT MAX(day) AS d FROM rate_days WHERE published = 1")!.d,
        pending: one<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE rate_source = 'pending'")!.n,
      }),
    };
  }

  function gauges() {
    const claims: Record<string, number> = {};
    for (const r of q<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM claims GROUP BY state")) claims[r.state] = r.n;
    return {
      claims,
      pendingSteps: one<{ n: number }>("SELECT COUNT(*) AS n FROM steps WHERE state = 'pending'")!.n,
      ratesPending: one<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE rate_source = 'pending'")!.n,
      receiptsReading: one<{ n: number }>("SELECT COUNT(*) AS n FROM receipts WHERE read_state = 'pending'")!.n,
      unmatchedCard: one<{ n: number }>("SELECT COUNT(*) AS n FROM card_transactions WHERE item_id IS NULL")!.n,
      links: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, v.error ? 0 : 1])),
      counters,
    };
  }

  return {
    store,
    config: () => config,
    cfg,
    today,
    setConfig,
    settings,
    policy,
    people,
    projects,
    syncHr,
    syncTime,
    addReceipt,
    getReceipt,
    receiptFile,
    removeReceipt,
    readReceipts,
    listClaims,
    createClaim,
    getClaim,
    updateClaim,
    removeClaim,
    addItem,
    updateItem,
    removeItem,
    getItem: (who: Actor, id: string) => itemOut(mustItem(who, id).item),
    matchCard,
    retryRates,
    submit,
    withdraw,
    decide,
    reassign,
    me,
    setIban,
    summary,
    rateQuote,
    listBatches,
    createBatch,
    getBatch,
    updateBatch,
    removeBatch,
    sendBatch,
    paidBatch,
    transfers,
    payroll,
    tick,
    integrations,
    gauges,
    isFinance,
    refresh,
    departmentName,
    projectOut,
    itemOut,
    canSee,
  };
}
export type Expenses = ReturnType<typeof createExpenses>;
