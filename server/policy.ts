// The policy, as the file sets it, applied to one claim's items: limits per item, per day and per month by category,
// receipts, late receipts, duplicates and what the reader read. Nothing here reads the database: expenses.ts hands in
// what the person already spent in other claims and the earlier items that look the same.
import type { Category, Config } from "./config.ts";
import { decimalText } from "./money.ts";
import { daysBetween } from "./store.ts";

export type FlagCode = "over-limit" | "no-receipt" | "duplicate" | "same-file" | "late" | "receipt-differs";

export interface Flag {
  code: FlagCode;
  text: string;
  /** Finance must approve the claim. */
  finance: boolean;
  /** The claim cannot be sent while it is there. */
  blocks: boolean;
  /** For duplicates: the claim and item it looks like. */
  of?: { claim: string; item: string };
}

export interface PolicyItem {
  id: string;
  kind: "receipt" | "mileage" | "per_diem";
  category: string;
  project: string | null;
  date: string;
  /** In kuruş; null while its rate is not known. */
  amountTry: number | null;
  paidBy: "employee" | "company";
  hasReceipt: boolean;
  noReceiptReason: string | null;
  /** Earlier items with the same seller, date and amount, and with the same receipt file. */
  lookalikes: Array<{ claim: string; item: string; sameFile: boolean }>;
  /** What the reader read and what was entered differ in these fields. */
  differs: string[];
}

export interface Usage {
  /** Kuruş already spent in other sent claims, by category and day (YYYY-MM-DD) or month (YYYY-MM). */
  day(category: string, day: string): number;
  month(category: string, month: string): number;
}

export interface Checked {
  flags: Flag[];
  /** Kuruş over a capped limit, not paid back. */
  held: number;
}

const tl = (kurus: number) => `${decimalText(kurus, "TRY")} TRY`;

/** Each item's flags and held amount, in the order given (by date, then position). */
export function checkItems(c: Config, items: PolicyItem[], usage: Usage, today: string): Map<string, Checked> {
  const out = new Map<string, Checked>();
  const dayUsed = new Map<string, number>();
  const monthUsed = new Map<string, number>();
  for (const it of items) {
    const cat: Category | undefined = c.categories.find((x) => x.id === it.category);
    const flags: Flag[] = [];
    let held = 0;
    if (cat && it.amountTry !== null) {
      const a = it.amountTry;
      const dk = `${cat.id}|${it.date}`;
      const mk = `${cat.id}|${it.date.slice(0, 7)}`;
      const usedDay = usage.day(cat.id, it.date) + (dayUsed.get(dk) ?? 0);
      const usedMonth = usage.month(cat.id, it.date.slice(0, 7)) + (monthUsed.get(mk) ?? 0);
      dayUsed.set(dk, (dayUsed.get(dk) ?? 0) + a);
      monthUsed.set(mk, (monthUsed.get(mk) ?? 0) + a);
      const overs: Array<{ over: number; text: string }> = [];
      const { perItem, perDay, perMonth } = cat.limits;
      if (perItem !== null && a > perItem) overs.push({ over: a - perItem, text: `${tl(a)} is over ${cat.name}'s limit of ${tl(perItem)} an item` });
      if (perDay !== null && usedDay + a > perDay)
        overs.push({ over: Math.min(a, usedDay + a - perDay), text: `${tl(usedDay + a)} on ${it.date} is over ${cat.name}'s limit of ${tl(perDay)} a day` });
      if (perMonth !== null && usedMonth + a > perMonth)
        overs.push({
          over: Math.min(a, usedMonth + a - perMonth),
          text: `${tl(usedMonth + a)} in ${it.date.slice(0, 7)} is over ${cat.name}'s limit of ${tl(perMonth)} a month`,
        });
      if (overs.length) {
        const worst = overs.reduce((x, y) => (y.over > x.over ? y : x));
        const capped = cat.overLimit === "cap" && it.paidBy === "employee";
        if (capped) held = worst.over;
        flags.push({
          code: "over-limit",
          text: `${worst.text}.${capped ? ` ${tl(worst.over)} is not paid back.` : cat.overLimit === "block" ? " Lower it to send the claim." : ""}`,
          finance: cat.overLimit === "flag" || (cat.overLimit === "cap" && it.paidBy === "company"),
          blocks: cat.overLimit === "block",
        });
      }
    }
    if (it.kind === "receipt" && !it.hasReceipt)
      flags.push({
        code: "no-receipt",
        text: it.noReceiptReason ? `No receipt: ${it.noReceiptReason}` : "No receipt and no reason; add the receipt's photo or say why there is none.",
        finance: true,
        blocks: !it.noReceiptReason,
      });
    for (const l of it.lookalikes)
      flags.push({
        code: l.sameFile ? "same-file" : "duplicate",
        text: l.sameFile ? `The same receipt file is on ${l.claim}.` : `A receipt with the same seller, date and amount is on ${l.claim}.`,
        finance: true,
        blocks: false,
        of: { claim: l.claim, item: l.item },
      });
    if (c.receipts.maxAgeDays !== null && it.kind === "receipt" && daysBetween(it.date, today) > c.receipts.maxAgeDays)
      flags.push({
        code: "late",
        text: `The receipt is ${daysBetween(it.date, today)} days old; the policy takes them for ${c.receipts.maxAgeDays} days.`,
        finance: true,
        blocks: false,
      });
    if (it.differs.length)
      flags.push({
        code: "receipt-differs",
        text: `The ${it.differs.join(" and ")} entered ${it.differs.length > 1 ? "differ" : "differs"} from what was read on the receipt.`,
        finance: false,
        blocks: false,
      });
    out.set(it.id, { flags, held });
  }
  return out;
}

/** What stops a claim from being sent, beyond the items' blocking flags. */
export function claimBlocks(c: Config, items: PolicyItem[]): string[] {
  const out: string[] = [];
  if (!items.length) out.push("The claim has no items.");
  for (const it of items) {
    const cat = c.categories.find((x) => x.id === it.category);
    if (!cat) out.push(`An item on ${it.date} is in ${it.category}, a category the file no longer has.`);
    else if (cat.project === "required" && !it.project) out.push(`${cat.name} on ${it.date} needs a project.`);
    if (it.amountTry === null) out.push(`The rate for the item on ${it.date} is not known yet; it is fetched from TCMB again shortly.`);
  }
  return out;
}

/** Sellers compared without case, punctuation or the company form: "Acme Ltd. Şti." is "acme". */
export function sellerKey(seller: string | null): string | null {
  if (!seller) return null;
  const legal = new Set(["as", "aş", "ltd", "şti", "sti", "san", "tic", "ve", "a", "ş", "inc", "llc", "gmbh", "co", "ltdşti"]);
  const words = seller
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !legal.has(w));
  const k = words.join("");
  return k || null;
}
