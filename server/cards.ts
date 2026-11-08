// Company card statements, imported as the bank's CSV. Cards are not issued here; their statements come in as files.
// Each purchase is kept once (a line imported again is a duplicate), given to its holder by the card's last four
// digits (cards.holders in the file) or a holder column, and matched to the holder's draft receipt with the same
// amount within cards.match_days. A matched receipt is the company's: it is not paid back, and its TRY amount is what
// the card was charged.
import { createHash, randomUUID } from "node:crypto";
import { atLeast } from "@openasy/auth";
import type { CardColumn } from "./config.ts";
import { parseCsv, parseDay } from "./csv.ts";
import type { Expenses } from "./expenses.ts";
import { knownCurrency, minorDigits, parseDecimal } from "./money.ts";
import { bad, body, day, forbidden, isDay, text, type Actor } from "./store.ts";

interface TxRow {
  id: string;
  import_id: string;
  card: string | null;
  holder_email: string | null;
  date: string;
  description: string;
  amount_try: number;
  currency: string | null;
  amount: number | null;
  item_id: string | null;
  created_at: string;
}

const norm = (s: string) => s.trim().toLocaleLowerCase("tr").replace(/\s+/g, " ");

export function createCards(x: Expenses) {
  const { q, one, run, tx, iso } = x.store;

  function importCsv(who: Actor, raw: unknown) {
    if (!x.isFinance(who)) throw forbidden("Importing card statements needs the editor role.");
    const b = body(raw, ["csv", "filename", "check"]);
    if (typeof b.csv !== "string" || !b.csv.trim()) throw bad("csv is the statement's text, as the bank's CSV export writes it.");
    const filename = b.filename === undefined || b.filename === null ? null : text(b.filename, "filename", 200);
    const check = b.check === true;
    const c = x.cfg();
    const rows = parseCsv(b.csv);
    // Banks put a few lines about the account above the table: the header is the first line naming a date and an amount.
    const find = (cells: string[], col: CardColumn) => {
      const names = c.cards.columns[col].map(norm);
      return cells.findIndex((h) => names.includes(norm(h)));
    };
    const headerAt = rows.slice(0, 20).findIndex((r) => find(r, "date") >= 0 && find(r, "amount") >= 0);
    if (headerAt < 0)
      throw bad(
        `No header line with a date and an amount column; the file looks for ${c.cards.columns.date.join(" or ")} and ${c.cards.columns.amount.join(" or ")} (cards.columns).`,
      );
    const header = rows[headerAt]!;
    const col = Object.fromEntries((Object.keys(c.cards.columns) as CardColumn[]).map((k) => [k, find(header, k)])) as Record<CardColumn, number>;
    if (col.description < 0) throw bad(`No description column; the file looks for ${c.cards.columns.description.join(" or ")}.`);

    const errors: Array<{ line: number; error: string }> = [];
    const seen = new Map<string, number>();
    const added: Array<TxRow & { hash: string }> = [];
    let duplicates = 0;
    let skipped = 0;
    const importId = randomUUID();
    rows.slice(headerAt + 1).forEach((r, i) => {
      const line = headerAt + i + 2;
      const cell = (k: CardColumn) => (col[k] >= 0 ? (r[col[k]] ?? "").trim() : "");
      const date = parseDay(cell("date"));
      const description = cell("description").slice(0, 200);
      const amount = parseDecimal(cell("amount").replace(/TL|TRY|₺/gi, ""), 2);
      if (!date && (!cell("amount") || !description)) return void skipped++; // a total or a blank line under the table
      if (!date) return void errors.push({ line, error: `${cell("date") || "(empty)"} is not a date.` });
      if (amount === null) return void errors.push({ line, error: `${cell("amount") || "(empty)"} is not an amount.` });
      if (!description) return void errors.push({ line, error: "The description is empty." });
      // Payments to the card and refunds have the other sign: they are not purchases.
      const purchase = c.cards.purchases === "positive" ? amount > 0 : amount < 0;
      if (!purchase) return void skipped++;
      const digits = cell("card").replace(/\D/g, "");
      const card = digits.length >= 4 ? digits.slice(-4) : null;
      const holderCell = cell("holder").toLowerCase();
      const holder = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(holderCell) ? holderCell : card ? (c.cards.holders[card] ?? null) : null;
      let currency: string | null = cell("currency").toUpperCase().replace(/^TL$/, "TRY") || null;
      let original: number | null = null;
      if (currency && currency !== "TRY" && knownCurrency(currency) && cell("original_amount")) {
        original = parseDecimal(cell("original_amount"), minorDigits(currency));
        original = original === null ? null : Math.abs(original);
      }
      if (!currency || currency === "TRY" || !knownCurrency(currency) || original === null) {
        currency = null;
        original = null;
      }
      const key = [card ?? "", date, Math.abs(amount), norm(description)].join("|");
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      // The same purchase twice on one day is two lines; the same line in the next month's file is not a new one.
      const hash = createHash("sha256").update(`${key}|${n}`).digest("hex");
      if (one("SELECT 1 FROM card_transactions WHERE hash = ?", hash)) return void duplicates++;
      added.push({
        id: randomUUID(),
        hash,
        import_id: importId,
        card,
        holder_email: holder,
        date,
        description,
        amount_try: Math.abs(amount),
        currency,
        amount: original,
        item_id: null,
        created_at: iso(),
      });
    });

    let matched = 0;
    if (!check) {
      tx(() => {
        run(
          "INSERT INTO card_imports (id, filename, by_name, at, added, duplicates, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)",
          importId,
          filename,
          who.name,
          iso(),
          added.length,
          duplicates,
          skipped,
        );
        for (const t of added)
          run(
            `INSERT INTO card_transactions (id, import_id, hash, card, holder_email, date, description, amount_try, currency, amount, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            t.id,
            t.import_id,
            t.hash,
            t.card,
            t.holder_email,
            t.date,
            t.description,
            t.amount_try,
            t.currency,
            t.amount,
            t.created_at,
          );
      });
      // Draft receipts of the holders that a new purchase pays for.
      const holders = [...new Set(added.map((t) => t.holder_email).filter((h): h is string => !!h))];
      for (const h of holders)
        for (const it of q<{ id: string }>(
          `SELECT i.id FROM items i JOIN claims c ON c.id = i.claim_id
           WHERE c.owner_email = ? AND c.state = 'draft' AND i.kind = 'receipt' AND i.card_tx_id IS NULL ORDER BY i.date, i.position`,
          h,
        ))
          if (x.matchCard(it.id)) matched++;
    }
    return {
      check,
      import: check ? null : importId,
      added: added.length,
      duplicates,
      skipped,
      matched,
      withoutHolder: added.filter((t) => !t.holder_email).length,
      errors: errors.slice(0, 200),
    };
  }

  function listImports() {
    return q<{ id: string; filename: string | null; by_name: string; at: string; added: number; duplicates: number; skipped: number }>(
      "SELECT * FROM card_imports ORDER BY at DESC LIMIT 200",
    ).map((r) => ({ id: r.id, filename: r.filename, by: r.by_name, at: r.at, added: r.added, duplicates: r.duplicates, skipped: r.skipped }));
  }

  function txOut(t: TxRow) {
    const claim = t.item_id
      ? one<{ id: string; number: string }>("SELECT c.id, c.number FROM items i JOIN claims c ON c.id = i.claim_id WHERE i.id = ?", t.item_id)
      : undefined;
    return {
      id: t.id,
      card: t.card,
      holder: t.holder_email,
      date: t.date,
      description: t.description,
      amountTry: t.amount_try,
      currency: t.currency,
      amount: t.amount,
      item: t.item_id && claim ? { id: t.item_id, claim: claim.id, number: claim.number } : null,
      importedAt: t.created_at,
    };
  }

  function listTransactions(who: Actor, query: URLSearchParams) {
    const where: string[] = [];
    const args: string[] = [];
    if (!atLeast(who.role, "viewer")) {
      if (!who.email) throw forbidden("Card purchases are listed for their holder: sign in.");
      where.push("holder_email = ?");
      args.push(who.email.toLowerCase());
    } else if (query.get("holder")) {
      where.push("holder_email = ?");
      args.push(query.get("holder")!.toLowerCase());
    }
    const state = query.get("state") ?? "all";
    if (state === "unmatched") where.push("item_id IS NULL");
    else if (state === "matched") where.push("item_id IS NOT NULL");
    else if (state !== "all") throw bad("state is unmatched, matched or all.");
    for (const [k, op] of [
      ["from", ">="],
      ["to", "<="],
    ] as const) {
      const v = query.get(k);
      if (v) {
        if (!isDay(v)) day(v, k);
        where.push(`date ${op} ?`);
        args.push(v);
      }
    }
    return q<TxRow>(
      `SELECT * FROM card_transactions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY date DESC, created_at DESC LIMIT 1000`,
      ...args,
    ).map(txOut);
  }

  return { importCsv, listImports, listTransactions };
}
export type Cards = ReturnType<typeof createCards>;
