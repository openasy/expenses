// Reports and exports for finance and the accountant: spending by category, department, project, person or month,
// what went over policy, KDV by rate, every item as CSV with its account code and KDV per rate, and the receipts as a
// ZIP whose file names the CSV gives. Periods are by the day on the receipt; approved and paid claims count unless
// submitted ones are asked for too.
import { csvText } from "./csv.ts";
import type { ClaimRow, Expenses, ItemRow } from "./expenses.ts";
import { decimalText, rateText } from "./money.ts";
import type { Flag } from "./policy.ts";
import { bad, isDay, type Actor } from "./store.ts";
import { zip, type ZipEntry } from "./zip.ts";

type Row = ItemRow & Pick<ClaimRow, "number" | "owner_name" | "owner_email" | "department" | "batch_id" | "paid_at"> & { claim_state: ClaimRow["state"] };

const BY = ["category", "department", "project", "person", "month"] as const;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };

const slug = (s: string | null) =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .toLowerCase() || "receipt";

export function createReports(x: Expenses) {
  const { q, one } = x.store;

  function range(query: URLSearchParams) {
    const t = x.today();
    const from = query.get("from") ?? `${t.slice(0, 7)}-01`;
    const to = query.get("to") ?? t;
    if (!isDay(from) || !isDay(to)) throw bad("from and to are days, YYYY-MM-DD.");
    if (from > to) throw bad("from is on or before to.");
    if (Date.parse(to) - Date.parse(from) > 3 * 366 * 86_400_000) throw bad("A report covers at most three years.");
    return { from, to };
  }

  function states(query: URLSearchParams): string[] {
    const inc = query.get("include");
    if (inc && inc !== "submitted") throw bad("include is submitted, to count claims still waiting for approval.");
    return inc ? ["submitted", "approved", "paid"] : ["approved", "paid"];
  }

  function rows(from: string, to: string, st: string[]): Row[] {
    return q<Row>(
      `SELECT i.*, c.number, c.owner_name, c.owner_email, c.department, c.batch_id, c.paid_at, c.state AS claim_state
       FROM items i JOIN claims c ON c.id = i.claim_id
       WHERE i.date BETWEEN ? AND ? AND c.state IN (${st.map(() => "?").join(", ")})
       ORDER BY i.date, c.number, i.position LIMIT 200000`,
      from,
      to,
      ...st,
    );
  }

  const kdvOf = (r: ItemRow) => (JSON.parse(r.vat) as Array<{ rate: number; amount: number }>).reduce((s, v) => s + v.amount, 0);

  function spend(query: URLSearchParams) {
    const { from, to } = range(query);
    const by = (query.get("by") ?? "category") as (typeof BY)[number];
    if (!BY.includes(by)) throw bad(`by is ${BY.join(", ")}.`);
    const groups = new Map<
      string,
      { key: string | null; name: string; total: number; kdv: number; count: number; companyPaid: number; reimbursable: number }
    >();
    let total = 0;
    for (const r of rows(from, to, states(query))) {
      const amount = r.amount_try ?? 0;
      const key =
        by === "category"
          ? r.category
          : by === "department"
            ? r.department
            : by === "project"
              ? r.project
              : by === "person"
                ? r.owner_email
                : r.date.slice(0, 7);
      const name =
        by === "category"
          ? (x.config()?.categories.find((c) => c.id === r.category)?.name ?? r.category)
          : by === "department"
            ? (x.departmentName(r.department) ?? "No department")
            : by === "project"
              ? (x.projectOut(r.project)?.name ?? "No project")
              : by === "person"
                ? r.owner_name
                : r.date.slice(0, 7);
      const g = groups.get(key ?? "") ?? { key, name, total: 0, kdv: 0, count: 0, companyPaid: 0, reimbursable: 0 };
      g.total += amount;
      g.kdv += kdvOf(r);
      g.count++;
      if (r.paid_by === "company") g.companyPaid += amount;
      else g.reimbursable += amount - r.held;
      groups.set(key ?? "", g);
      total += amount;
    }
    const list = [...groups.values()].sort((a, b) => (by === "month" ? (a.key ?? "").localeCompare(b.key ?? "") : b.total - a.total));
    return { from, to, by, currency: "TRY" as const, total, rows: list.map((g) => ({ ...g, net: g.total - g.kdv })) };
  }

  function policyReport(query: URLSearchParams) {
    const { from, to } = range(query);
    const out = [];
    for (const r of rows(from, to, ["submitted", "approved", "paid"])) {
      const flags = JSON.parse(r.flags) as Flag[];
      if (!flags.length) continue;
      out.push({
        claim: { id: r.claim_id, number: r.number, state: r.claim_state, owner: { name: r.owner_name, email: r.owner_email } },
        item: { id: r.id, date: r.date, category: r.category, seller: r.seller, amountTry: r.amount_try, held: r.held },
        flags,
      });
    }
    return { from, to, items: out };
  }

  function kdvReport(query: URLSearchParams) {
    const { from, to } = range(query);
    const byRate = new Map<number, { rate: number; base: number; kdv: number; count: number }>();
    const byDoc = new Map<string, { document: string; total: number; kdv: number; count: number }>();
    for (const r of rows(from, to, states(query))) {
      if (r.kind !== "receipt") continue;
      const vat = JSON.parse(r.vat) as Array<{ rate: number; amount: number }>;
      const k = vat.reduce((s, v) => s + v.amount, 0);
      const d = byDoc.get(r.document) ?? { document: r.document, total: 0, kdv: 0, count: 0 };
      d.total += r.amount_try ?? 0;
      d.kdv += k;
      d.count++;
      byDoc.set(r.document, d);
      for (const v of vat) {
        const g = byRate.get(v.rate) ?? { rate: v.rate, base: 0, kdv: 0, count: 0 };
        // The base of a rate is its KDV grossed down: kdv * 100 / rate. A 0% line carries no base of its own.
        g.base += v.rate > 0 ? Math.round((v.amount * 100) / v.rate) : 0;
        g.kdv += v.amount;
        g.count++;
        byRate.set(v.rate, g);
      }
    }
    return {
      from,
      to,
      currency: "TRY" as const,
      rates: [...byRate.values()].sort((a, b) => a.rate - b.rate),
      documents: [...byDoc.values()].sort((a, b) => a.document.localeCompare(b.document)),
    };
  }

  /** What Time shows on a project: approved and paid spending charged to it, without KDV too, by category. */
  function projectCosts(query: URLSearchParams) {
    const { from, to } = range(query);
    const only = query.get("project");
    const out = new Map<string, { id: string; name: string; total: number; kdv: number; count: number; categories: Map<string, number> }>();
    for (const r of rows(from, to, ["approved", "paid"])) {
      if (!r.project || (only && r.project !== only)) continue;
      const g = out.get(r.project) ?? { id: r.project, name: x.projectOut(r.project)!.name, total: 0, kdv: 0, count: 0, categories: new Map<string, number>() };
      g.total += r.amount_try ?? 0;
      g.kdv += kdvOf(r);
      g.count++;
      g.categories.set(r.category, (g.categories.get(r.category) ?? 0) + (r.amount_try ?? 0));
      out.set(r.project, g);
    }
    return {
      from,
      to,
      currency: "TRY" as const,
      projects: [...out.values()].map((g) => ({
        id: g.id,
        name: g.name,
        total: g.total,
        kdv: g.kdv,
        net: g.total - g.kdv,
        count: g.count,
        categories: [...g.categories].map(([id, amount]) => ({ id, name: x.config()?.categories.find((c) => c.id === id)?.name ?? id, amount })),
      })),
    };
  }

  function receiptPath(r: Row, contentType: string) {
    return `${r.number}/${String(r.position).padStart(2, "0")}-${r.date}-${slug(r.seller)}.${EXT[contentType] ?? "bin"}`;
  }

  /** Every item in the period, one line each, for the accountant. */
  function exportItems(_who: Actor, query: URLSearchParams): { filename: string; text: string } {
    const { from, to } = range(query);
    const c = x.cfg();
    const sep = c.exports.separator;
    const dec = c.exports.decimal;
    const money = (n: number | null, cur = "TRY") => (n === null ? null : decimalText(n, cur, dec));
    const head = [
      "claim",
      "state",
      "person",
      "email",
      "employee_id",
      "department",
      "date",
      "category",
      "account",
      "project",
      "kind",
      "description",
      "seller",
      "seller_tax_number",
      "document",
      "document_number",
      "currency",
      "amount",
      "rate",
      "rate_day",
      "amount_try",
      ...c.kdvRates.map((r) => `kdv_${r}`),
      "kdv",
      "net",
      "paid_by",
      "reimbursable",
      "held",
      "km",
      "days",
      "country",
      "flags",
      "batch",
      "paid_at",
      "receipt_file",
    ];
    const lines: Array<Array<string | number | null>> = [head];
    for (const r of rows(from, to, states(query))) {
      const vat = JSON.parse(r.vat) as Array<{ rate: number; amount: number }>;
      const kdv = vat.reduce((s, v) => s + v.amount, 0);
      const cat = c.categories.find((k) => k.id === r.category);
      const p = one<{ employee_id: string | null }>("SELECT employee_id FROM people WHERE email = ?", r.owner_email);
      const batch = r.batch_id ? one<{ number: string }>("SELECT number FROM batches WHERE id = ?", r.batch_id) : undefined;
      const receipt = r.receipt_id ? one<{ content_type: string }>("SELECT content_type FROM receipts WHERE id = ?", r.receipt_id) : undefined;
      lines.push([
        r.number,
        r.claim_state,
        r.owner_name,
        r.owner_email,
        p?.employee_id ?? null,
        x.departmentName(r.department),
        r.date,
        cat?.name ?? r.category,
        cat?.account ?? null,
        r.project,
        r.kind,
        r.description,
        r.seller,
        r.seller_tax_number,
        r.document,
        r.document_number,
        r.currency,
        money(r.amount, r.currency),
        r.rate_micro === null ? null : rateText(r.rate_micro, dec),
        r.rate_day,
        money(r.amount_try),
        ...c.kdvRates.map((rate) => {
          const v = vat.find((l) => l.rate === rate);
          return v ? money(v.amount) : null;
        }),
        money(kdv),
        r.amount_try === null ? null : money(r.amount_try - kdv),
        r.paid_by,
        r.paid_by === "employee" && r.amount_try !== null ? money(r.amount_try - r.held) : money(0),
        money(r.held),
        r.km_tenths === null ? null : (r.km_tenths / 10).toFixed(1).replace(".", dec),
        r.half_days === null ? null : (r.half_days / 2).toFixed(1).replace(".", dec),
        r.country,
        (JSON.parse(r.flags) as Flag[]).map((f) => f.code).join(" ") || null,
        batch?.number ?? null,
        r.paid_at?.slice(0, 10) ?? null,
        receipt ? receiptPath(r, receipt.content_type) : null,
      ]);
    }
    return { filename: `expenses-${from}-${to}.csv`, text: csvText(lines, sep) };
  }

  /** The receipts of the period's items, by claim, named as the CSV names them. */
  function exportReceipts(query: URLSearchParams): { filename: string; zip: Buffer } {
    const { from, to } = range(query);
    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let size = 0;
    for (const r of rows(from, to, states(query))) {
      if (!r.receipt_id) continue;
      const f = one<{ content_type: string; data: Uint8Array; created_at: string }>(
        "SELECT content_type, data, created_at FROM receipts WHERE id = ?",
        r.receipt_id,
      );
      if (!f) continue;
      const name = receiptPath(r, f.content_type);
      if (seen.has(name)) continue;
      seen.add(name);
      size += f.data.length;
      if (size > 1024 * 1024 * 1024) throw bad("The receipts of this period are more than 1 GB; ask for a shorter period.");
      entries.push({ name, data: Buffer.from(f.data), at: new Date(f.created_at) });
    }
    return { filename: `receipts-${from}-${to}.zip`, zip: zip(entries) };
  }

  return { spend, policyReport, kdvReport, projectCosts, exportItems, exportReceipts };
}
export type Reports = ReturnType<typeof createReports>;
