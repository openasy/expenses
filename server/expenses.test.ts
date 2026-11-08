import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unzip } from "./zip.ts";
import { ALI, DENIZ, EMILY, FATMA, HAKAN, jpeg, LINKED, PDF, SELIN, startApp, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeEach(async () => {
  app = await startApp();
});
afterEach(() => app.close());

/** Makes a draft claim as a member and adds items; returns the claim's id. */
async function claimWith(who = ALI, items: unknown[] = [], title = "Customer visit") {
  const c = await app.as(who)("POST", "/api/v1/claims", { title });
  expect(c.status).toBe(201);
  for (const i of items) {
    const r = await app.as(who)("POST", `/api/v1/claims/${c.body.id}/items`, i);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  return c.body.id as string;
}

describe("Ali's customer visit: photographed, approved and paid with his salary", () => {
  it("reads the receipt, sends it to his manager and finance, and hands it to Payroll", async () => {
    // The taxi receipt is photographed; the reader reads it in the background.
    const up = await app.upload(ALI, jpeg(1), "image/jpeg", "lunch.jpg");
    expect(up.status).toBe(201);
    await app.x.readReceipts();
    const r = await app.as(ALI)("GET", `/api/v1/receipts/${up.body.id}`);
    expect(r.body.read).toMatchObject({ state: "read", fields: { amount: 64_000, date: "2026-10-30", seller: "Kuzu Lokantası" } });
    expect(app.fakes.state.reader.hits).toEqual([{ type: "image/jpeg", size: r.body.size }]);

    const id = await claimWith(ALI, [], "Acme visit");
    const lunch = await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, { category: "meals", project: "acme", receipt: up.body.id });
    expect(lunch.status).toBe(201);
    expect(lunch.body).toMatchObject({
      date: "2026-10-30",
      seller: "Kuzu Lokantası",
      currency: "TRY",
      amount: 64_000,
      amountTry: 64_000,
      document: "receipt",
      vat: [{ rate: 10, amount: 5_818 }],
      kdv: 5_818,
      net: 58_182,
      readUsed: ["date", "seller", "currency", "amount"],
      project: { id: "acme", name: "Acme rollout" },
      category: { id: "meals", name: "Meals", account: "770.02" },
      flags: [],
    });
    // The taxi had no printer: a reason, and finance looks at it.
    const taxi = await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, {
      category: "travel",
      date: "2026-10-30",
      amount: 25_000,
      seller: "İstanbul Taksi",
      noReceiptReason: "The taxi had no printer.",
    });
    expect(taxi.body).toMatchObject({ document: "none", vat: [], flags: [{ code: "no-receipt", finance: true }] });

    const sent = await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ state: "submitted", total: 89_000, reimbursable: 89_000, department: { id: "sales", name: "Sales" } });
    expect(sent.body.steps.map((s: any) => [s.kind, s.approver?.email ?? null, s.state])).toEqual([
      ["manager", "emily@example.com", "pending"],
      ["finance", null, "waiting"],
    ]);

    // Emily sees it waiting for her, and nobody else's.
    const mine = await app.as(EMILY)("GET", "/api/v1/claims?scope=approvals");
    expect(mine.body.claims.map((c: any) => c.id)).toEqual([id]);
    expect(mine.body.claims[0].canDecide).toBe(true);
    expect((await app.as(FATMA)("GET", "/api/v1/claims?scope=approvals")).body.claims).toEqual([]);
    expect((await app.as(ALI)("POST", `/api/v1/claims/${id}/approve`, {})).status).toBe(403);
    expect((await app.as(FATMA)("POST", `/api/v1/claims/${id}/approve`, {})).status).toBe(403);

    expect((await app.as(EMILY)("POST", `/api/v1/claims/${id}/approve`, { comment: "OK" })).body.pending).toMatchObject({ kind: "finance" });
    expect((await app.as(FATMA)("GET", "/api/v1/claims?scope=approvals")).body.claims).toHaveLength(1);
    const done = await app.as(FATMA)("POST", `/api/v1/claims/${id}/approve`, {});
    expect(done.body).toMatchObject({ state: "approved", pending: null });

    // Finance pays it with the November salary.
    const batch = await app.as(FATMA)("POST", "/api/v1/batches", { method: "payroll", payDate: "2026-11-30" });
    expect(batch.status).toBe(201);
    expect(batch.body).toMatchObject({ method: "payroll", state: "open", total: 89_000, people: 1, claims: 1 });
    expect((await app.as(FATMA)("POST", `/api/v1/batches/${batch.body.id}/send`)).body.state).toBe("sent");
    const payroll = await app.as("admin")("GET", "/api/v1/payroll?month=2026-11");
    expect(payroll.body.batches).toHaveLength(1);
    expect(payroll.body.batches[0].people).toEqual([
      {
        email: "ali@example.com",
        name: "Ali Demir",
        employeeId: "1042",
        amount: 89_000,
        claims: [{ id, number: "EXP-2026-0001", title: "Acme visit", amount: 89_000 }],
        lines: [
          { category: "meals", name: "Meals", account: "770.02", project: "acme", amount: 64_000 },
          { category: "travel", name: "Travel", account: "770.01", project: null, amount: 25_000 },
        ],
      },
    ]);
    expect((await app.as("admin")("GET", "/api/v1/payroll?month=2026-12")).body.batches).toEqual([]);
    const paid = await app.as("admin")("POST", `/api/v1/batches/${batch.body.id}/paid`, { paidOn: "2026-11-30" });
    expect(paid.body.state).toBe("paid");
    const after = await app.as(ALI)("GET", `/api/v1/claims/${id}`);
    expect(after.body).toMatchObject({ state: "paid", paidAt: "2026-11-30T12:00:00.000Z" });
    expect(after.body.history.map((h: any) => h.action)).toEqual(["created", "submitted", "approved", "approved", "in payment", "paid"]);
  });
});

describe("who sees and changes what", () => {
  it("keeps a claim to its owner, its approvers and those who read everything", async () => {
    const id = await claimWith(ALI, [{ category: "travel", date: "2026-10-30", amount: 10_000, noReceiptReason: "Lost it." }]);
    expect((await app.as(DENIZ)("GET", `/api/v1/claims/${id}`)).status).toBe(404);
    expect((await app.as(EMILY)("GET", `/api/v1/claims/${id}`)).status).toBe(404);
    expect((await app.as(HAKAN)("GET", `/api/v1/claims/${id}`)).status).toBe(200);
    expect((await app.as(DENIZ)("GET", "/api/v1/claims?scope=all")).status).toBe(403);
    expect((await app.as(EMILY)("PATCH", `/api/v1/claims/${id}`, { title: "Mine now" })).status).toBe(404);
    expect((await app.as(HAKAN)("PATCH", `/api/v1/claims/${id}`, { title: "Mine now" })).status).toBe(403);
    await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    expect((await app.as(EMILY)("GET", `/api/v1/claims/${id}`)).status).toBe(200);
    // Sent: it changes no more until it is withdrawn.
    expect((await app.as(ALI)("PATCH", `/api/v1/claims/${id}`, { title: "Changed" })).status).toBe(409);
    expect((await app.as(ALI)("POST", `/api/v1/claims/${id}/withdraw`)).body.state).toBe("draft");
    expect((await app.as(ALI)("PATCH", `/api/v1/claims/${id}`, { title: "Changed" })).body.title).toBe("Changed");
    // An API token has no person: it cannot keep claims.
    expect((await app.as("admin")("POST", "/api/v1/claims", { title: "x" })).status).toBe(403);
  });

  it("sends back, starts a new round when sent again, and rejects for good", async () => {
    const id = await claimWith(ALI, [{ category: "travel", date: "2026-10-30", amount: 10_000, noReceiptReason: "Lost it." }]);
    await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    expect((await app.as(EMILY)("POST", `/api/v1/claims/${id}/return`, {})).status).toBe(422);
    const back = await app.as(EMILY)("POST", `/api/v1/claims/${id}/return`, { comment: "Which customer?" });
    expect(back.body.state).toBe("draft");
    await app.as(ALI)("PATCH", `/api/v1/claims/${id}`, { title: "Acme visit" });
    const again = await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    expect(again.body.steps.map((s: any) => s.state)).toEqual(["pending", "waiting"]);
    expect((await app.as(ALI)("DELETE", `/api/v1/claims/${id}`)).status).toBe(409);
    const no = await app.as(EMILY)("POST", `/api/v1/claims/${id}/reject`, { comment: "Not a business trip." });
    expect(no.body).toMatchObject({ state: "rejected", pending: null });
    expect(no.body.history.map((h: any) => h.action)).toEqual(["created", "submitted", "returned", "submitted", "rejected"]);
    expect((await app.as(FATMA)("POST", "/api/v1/batches", { method: "payroll" })).status).toBe(409);
  });

  it("lets finance pass a step whose approver is not a member to someone who is", async () => {
    const id = await claimWith(DENIZ, [
      {
        category: "software",
        project: "internal",
        date: "2026-10-30",
        amount: 3_000_000,
        document: "invoice",
        sellerTaxNumber: "1234567890",
        noReceiptReason: "e-Fatura",
      },
    ]);
    const sent = await app.as(DENIZ)("POST", `/api/v1/claims/${id}/submit`);
    // Engineering's chain over 20,000 TL, and finance for the invoice whose image is not attached.
    expect(sent.body.steps.map((s: any) => [s.approver?.email ?? "finance", s.approver?.member ?? null])).toEqual([
      ["can@example.com", false],
      ["selin@example.com", true],
      ["finance", null],
    ]);
    expect((await app.as(DENIZ)("POST", `/api/v1/claims/${id}/reassign`, { to: "hakan@example.com" })).status).toBe(403);
    expect((await app.as(FATMA)("POST", `/api/v1/claims/${id}/reassign`, { to: "deniz@example.com" })).status).toBe(422);
    expect((await app.as(FATMA)("POST", `/api/v1/claims/${id}/reassign`, { to: "nobody@example.com" })).status).toBe(422);
    const moved = await app.as(FATMA)("POST", `/api/v1/claims/${id}/reassign`, { to: "hakan@example.com", comment: "Can is not on Expenses yet." });
    expect(moved.body.pending.approver.email).toBe("hakan@example.com");
    await app.as(HAKAN)("POST", `/api/v1/claims/${id}/approve`, {});
    await app.as(SELIN)("POST", `/api/v1/claims/${id}/approve`, {});
    // Selin is finance too, but she approved a step already: Fatma takes the finance step.
    expect((await app.as(SELIN)("POST", `/api/v1/claims/${id}/approve`, {})).status).toBe(403);
    const done = await app.as(FATMA)("POST", `/api/v1/claims/${id}/approve`, {});
    expect(done.body.state).toBe("approved");
    // The software invoice carries 20% KDV from its category, as the file sets it.
    expect(done.body.lines[0]).toMatchObject({ vat: [{ rate: 20, amount: 500_000 }], sellerTaxNumber: "1234567890" });
  });

  it("never lets one finance member approve twice", async () => {
    // Over 10,000 TL: the manager and finance. Fatma is not Ali's manager, but Selin approving finance is someone else.
    const id = await claimWith(ALI, [{ category: "travel", date: "2026-10-30", amount: 1_200_000, noReceiptReason: "e-ticket by email" }]);
    await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    await app.as(EMILY)("POST", `/api/v1/claims/${id}/approve`, {});
    const r = await app.as(FATMA)("POST", `/api/v1/claims/${id}/reassign`, { to: "emily@example.com" });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("approved this claim already");
  });
});

describe("currencies and TCMB", () => {
  it("uses the rate announced the business day before, skipping Republic Day", async () => {
    const id = await claimWith(ALI);
    const r = await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, {
      category: "hotel",
      date: "2026-10-30",
      currency: "EUR",
      amount: 9_000,
      noReceiptReason: "x",
    });
    expect(r.body).toMatchObject({
      currency: "EUR",
      amount: 9_000,
      rate: { source: "tcmb", value: "48.5000", day: "2026-10-28" },
      amountTry: 436_500,
      vat: [],
    });
    // 29 October had no file; it is remembered and not asked again.
    expect(app.fakes.state.tcmb.hits).toEqual(["2026-10-29", "2026-10-28"]);
    await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, { category: "meals", date: "2026-10-30", currency: "JPY", amount: 3_000, noReceiptReason: "x" });
    expect(app.fakes.state.tcmb.hits).toEqual(["2026-10-29", "2026-10-28"]);
    const quote = await app.as(ALI)("GET", "/api/v1/rates?currency=JPY&date=2026-10-30");
    expect(quote.body).toEqual({ currency: "JPY", date: "2026-10-30", use: "forex_buying", day: "2026-10-28", rate: "0.2780", micro: 278_000 });
    // Foreign VAT is not KDV.
    const vat = await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, {
      category: "hotel",
      date: "2026-10-30",
      currency: "EUR",
      amount: 100,
      vat: [{ rate: 20 }],
    });
    expect(vat.status).toBe(422);
    expect((await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, { category: "hotel", date: "2026-10-30", currency: "CHF", amount: 100 })).status).toBe(422);
  });

  it("waits for TCMB when it cannot be reached, and holds the claim until the rate is known", async () => {
    app.fakes.state.tcmb.status = 503;
    const id = await claimWith(ALI, [{ category: "travel", date: "2026-10-30", currency: "USD", amount: 5_000, noReceiptReason: "x" }]);
    const c = await app.as(ALI)("GET", `/api/v1/claims/${id}`);
    expect(c.body.lines[0]).toMatchObject({ rate: { source: "pending" }, amountTry: null });
    expect(c.body.blocks[0]).toContain("is not known yet");
    expect((await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`)).status).toBe(409);
    expect((await app.as(ALI)("GET", "/api/v1/rates?currency=USD")).status).toBe(502);
    app.fakes.state.tcmb.status = 0;
    await app.x.retryRates();
    const later = await app.as(ALI)("GET", `/api/v1/claims/${id}`);
    expect(later.body.lines[0]).toMatchObject({ rate: { source: "tcmb", value: "42.1234" }, amountTry: 210_617 });
    expect((await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`)).status).toBe(200);
  });

  it("pays a foreign daily allowance and mileage by the file's rates", async () => {
    const id = await claimWith(ALI, [
      { category: "per-diem", date: "2026-10-28", days: 2.5, country: "DE" },
      { category: "per-diem", date: "2026-10-30", days: 1, country: "FR" },
      { category: "mileage", date: "2026-10-30", km: 120.5, route: "Kadıköy - Gebze - Kadıköy" },
    ]);
    const lines = (await app.as(ALI)("GET", `/api/v1/claims/${id}`)).body.lines;
    expect(lines.map((l: any) => [l.category.id, l.currency, l.amount, l.amountTry])).toEqual([
      ["per-diem", "EUR", 15_000, 720_000], // 2.5 days x 60 EUR, at 27 October's 48.0000
      ["per-diem", "EUR", 5_000, 242_500], // France has no rate: the default 50 EUR, at 28 October's 48.5000
      ["mileage", "TRY", 102_425, 102_425], // 120.5 km x 8.50
    ]);
  });
});

describe("the policy on a claim", () => {
  it("caps a hotel over its limit, blocks a gift over its limit and asks for a project", async () => {
    const id = await claimWith(ALI, [{ category: "hotel", date: "2026-10-30", amount: 620_000, noReceiptReason: "Hotel emails it." }]);
    let c = (await app.as(ALI)("GET", `/api/v1/claims/${id}`)).body;
    expect(c).toMatchObject({ total: 620_000, reimbursable: 500_000, held: 120_000 });
    expect(c.lines[0].flags[0].text).toContain("1200.00 TRY is not paid back");

    await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, { category: "gifts", date: "2026-10-30", amount: 150_000, noReceiptReason: "x" });
    await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, { category: "software", date: "2026-10-30", amount: 1_000, noReceiptReason: "x" });
    const refused = await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toContain("Software on 2026-10-30 needs a project.");
    expect(refused.body.detail).toContain("Lower it to send the claim.");
    c = (await app.as(ALI)("GET", `/api/v1/claims/${id}`)).body;
    expect(c.blocks).toHaveLength(2);
  });

  it("refuses an item without a receipt or a reason when sending, and a day after today", async () => {
    const id = await claimWith(ALI, [{ category: "travel", date: "2026-10-30", amount: 1_000 }]);
    const r = await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    expect(r.status).toBe(409);
    expect(r.body.detail).toContain("add the receipt's photo or say why");
    expect((await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, { category: "travel", date: "2026-11-03", amount: 1_000 })).status).toBe(422);
  });

  it("flags a receipt with the same seller, date and amount as an earlier one, and brings finance in", async () => {
    const first = await claimWith(ALI, [{ category: "travel", date: "2026-10-30", amount: 25_000, seller: "İstanbul Taksi A.Ş.", noReceiptReason: "x" }]);
    await app.as(ALI)("POST", `/api/v1/claims/${first}/submit`);
    const second = await claimWith(EMILY, [{ category: "travel", date: "2026-10-30", amount: 25_000, seller: "ISTANBUL TAKSI", noReceiptReason: "x" }]);
    const c = (await app.as(EMILY)("GET", `/api/v1/claims/${second}`)).body;
    expect(c.lines[0].flags.map((f: any) => f.code)).toEqual(["no-receipt"]);
    // İ and I differ in Turkish: the same seller written as it is.
    const third = await claimWith(EMILY, [{ category: "travel", date: "2026-10-30", amount: 25_000, seller: "İstanbul Taksi", noReceiptReason: "x" }]);
    const t = (await app.as(EMILY)("GET", `/api/v1/claims/${third}`)).body;
    expect(t.lines[0].flags.find((f: any) => f.code === "duplicate")).toMatchObject({ of: { claim: "EXP-2026-0001" } });
  });

  it("flags the same receipt file on two claims", async () => {
    const up = await app.upload(ALI, jpeg(7));
    await app.x.readReceipts();
    const a = await claimWith(ALI, [{ category: "travel", receipt: up.body.id, amount: 30_000 }]);
    await app.as(ALI)("POST", `/api/v1/claims/${a}/submit`);
    const again = await app.upload(ALI, jpeg(7));
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(up.body.id);
    const b = await claimWith(ALI, [{ category: "meals", receipt: up.body.id, amount: 10_000, seller: "Other" }]);
    const c = (await app.as(ALI)("GET", `/api/v1/claims/${b}`)).body;
    expect(c.lines[0].flags.map((f: any) => f.code)).toContain("same-file");
    // What was entered differs from what the reader read.
    expect(c.lines[0].flags.map((f: any) => f.code)).toContain("receipt-differs");
  });

  it("checks the KDV against the receipt's total", async () => {
    const id = await claimWith(ALI);
    const post = (b: unknown) => app.as(ALI)("POST", `/api/v1/claims/${id}/items`, b);
    const base = { category: "meals", date: "2026-10-30", amount: 64_000, document: "receipt", noReceiptReason: "x" };
    expect((await post({ ...base, vat: [{ rate: 10, amount: 9_000 }] })).status).toBe(422);
    expect((await post({ ...base, vat: [{ rate: 8 }] })).status).toBe(422);
    expect((await post({ ...base, vat: [{ rate: 10 }, { rate: 20 }] })).status).toBe(422);
    const split = await post({
      ...base,
      vat: [
        { rate: 10, amount: 4_000 },
        { rate: 20, amount: 1_500 },
      ],
    });
    expect(split.body).toMatchObject({ kdv: 5_500, net: 58_500 });
    expect((await post({ ...base, document: "none", vat: [{ rate: 10 }] })).status).toBe(422);
    expect((await post({ ...base, document: "invoice", sellerTaxNumber: "123" })).status).toBe(422);
  });
});

describe("receipts are taken by their bytes and served so nothing in them runs", () => {
  it("refuses what is not an allowed type, sent as another, too large, or a PDF with scripts", async () => {
    expect((await app.upload(ALI, Buffer.from("<html><script>alert(1)</script></html>"), "image/jpeg")).status).toBe(415);
    expect((await app.upload(ALI, jpeg(2), "application/pdf", "x.pdf")).status).toBe(415);
    expect((await app.upload(ALI, Buffer.alloc(1100 * 1024, 0xff).fill(0xd8, 1, 2), "image/jpeg")).status).toBe(413);
    const js = Buffer.from("%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (x) >> >>\n", "latin1");
    expect((await app.upload(ALI, js, "application/pdf", "x.pdf")).status).toBe(415);
    expect((await app.upload(ALI, Buffer.alloc(0), "image/jpeg")).status).toBe(422);
  });

  it("shows images inline and downloads PDFs, in a sandbox, only to who may see them", async () => {
    const img = await app.upload(ALI, jpeg(3), "image/jpeg", "../../etc/öğle.JPG");
    expect(img.body.filename).toBe("etcöğle.JPG");
    const pdf = await app.upload(ALI, PDF, "application/pdf", "e-arsiv.pdf");
    expect(pdf.status).toBe(201);
    const get = (who = ALI, id = img.body.id) => fetch(`${app.base}/api/v1/receipts/${id}/file`, { headers: { authorization: `Bearer test-token-${who.id}` } });
    const a = await get();
    expect(a.headers.get("content-type")).toBe("image/jpeg");
    expect(a.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(a.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");
    const b = await get(ALI, pdf.body.id);
    expect(b.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''e-arsiv.pdf");
    expect((await get(DENIZ)).status).toBe(404);
    expect((await get(HAKAN)).status).toBe(200);
    // On a claim Emily approves, she sees it.
    const id = await claimWith(ALI, [{ category: "travel", receipt: img.body.id, date: "2026-10-30", amount: 1_000 }]);
    expect((await get(EMILY)).status).toBe(404);
    await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    expect((await get(EMILY)).status).toBe(200);
    expect((await app.as(ALI)("DELETE", `/api/v1/receipts/${img.body.id}`)).status).toBe(409);
    expect((await app.as(ALI)("DELETE", `/api/v1/receipts/${pdf.body.id}`)).status).toBe(204);
  });

  it("leaves an unclear reading to be typed in", async () => {
    app.fakes.state.reader.answer = { confidence: 0.4, amount: "6.40" };
    const up = await app.upload(ALI, jpeg(4));
    await app.x.readReceipts();
    expect((await app.as(ALI)("GET", `/api/v1/receipts/${up.body.id}`)).body.read.state).toBe("unclear");
    const id = await claimWith(ALI);
    const r = await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, { category: "travel", receipt: up.body.id });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("date is the day on the receipt");
  });
});

describe("company cards", () => {
  const statement = [
    "Garanti BBVA Kurumsal Kart Ekstresi",
    "Dönem;Ekim 2026",
    "",
    "İşlem Tarihi;Açıklama;Kart No;Tutar",
    "30.10.2026;KUZU LOKANTASI ISTANBUL;5400 **** **** 4417;640,00",
    "30.10.2026;SHELL KADIKOY;5400 **** **** 4417;1.250,50",
    "31.10.2026;ODEME - TESEKKURLER;5400 **** **** 4417;-5.000,00",
    "01.11.2026;AWS EMEA;5400 **** **** 9001;2.104,17",
    "01.11.2026;SHELL KADIKOY;5400 **** **** 1111;300,00",
    "Toplam;;;3.994,67",
  ].join("\n");

  it("imports a statement once, gives purchases to their holders and matches their draft receipts", async () => {
    const id = await claimWith(ALI, [{ category: "meals", date: "2026-10-30", amount: 64_000, seller: "Kuzu", noReceiptReason: "x" }]);
    expect((await app.as(ALI)("POST", "/api/v1/cards/imports", { csv: statement })).status).toBe(403);
    const check = await app.as(FATMA)("POST", "/api/v1/cards/imports", { csv: statement, check: true });
    expect(check.body).toMatchObject({ check: true, added: 4, skipped: 2, matched: 0 });
    const imp = await app.as(FATMA)("POST", "/api/v1/cards/imports", { csv: statement, filename: "ekim.csv" });
    expect(imp.body).toMatchObject({ added: 4, duplicates: 0, skipped: 2, matched: 1, withoutHolder: 1, errors: [] });
    expect((await app.as(FATMA)("POST", "/api/v1/cards/imports", { csv: statement })).body).toMatchObject({ added: 0, duplicates: 4 });

    const c = (await app.as(ALI)("GET", `/api/v1/claims/${id}`)).body;
    expect(c).toMatchObject({ total: 64_000, reimbursable: 0, companyPaid: 64_000 });
    expect(c.lines[0]).toMatchObject({ paidBy: "company", rate: { source: "card" } });
    const mine = await app.as(ALI)("GET", "/api/v1/cards/transactions?state=unmatched");
    expect(mine.body.transactions.map((t: any) => [t.description, t.amountTry])).toEqual([["SHELL KADIKOY", 125_050]]);
    expect((await app.as(FATMA)("GET", "/api/v1/cards/transactions?state=unmatched")).body.transactions).toHaveLength(3);

    // The fuel purchase becomes an expense from the card line.
    const fuel = await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, {
      category: "travel",
      cardTransaction: mine.body.transactions[0].id,
      noReceiptReason: "x",
    });
    expect(fuel.body).toMatchObject({ date: "2026-10-30", seller: "SHELL KADIKOY", amount: 125_050, amountTry: 125_050, paidBy: "company" });
    const other = (await app.as(DENIZ)("GET", "/api/v1/cards/transactions")).body.transactions[0];
    expect((await app.as(ALI)("POST", `/api/v1/claims/${id}/items`, { category: "travel", cardTransaction: other.id })).status).toBe(422);

    // Paid in full by the card: approved, nothing to pay back.
    await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    await app.as(EMILY)("POST", `/api/v1/claims/${id}/approve`, {});
    const done = await app.as(FATMA)("POST", `/api/v1/claims/${id}/approve`, {});
    expect(done.body.state).toBe("paid");
  });

  it("says which lines it cannot read", async () => {
    const r = await app.as(FATMA)("POST", "/api/v1/cards/imports", { csv: "Tarih;Açıklama;Tutar\n32.10.2026;X;10\n30.10.2026;;10\n30.10.2026;Y;abc\n" });
    expect(r.body.errors).toEqual([
      { line: 2, error: "32.10.2026 is not a date." },
      { line: 3, error: "The description is empty." },
      { line: 4, error: "abc is not an amount." },
    ]);
    expect((await app.as(FATMA)("POST", "/api/v1/cards/imports", { csv: "a;b\n1;2" })).status).toBe(422);
  });
});

describe("paying back by transfer", () => {
  it("needs everyone's IBAN, then writes the bank's list", async () => {
    const id = await claimWith(ALI, [{ category: "travel", date: "2026-10-30", amount: 25_000, noReceiptReason: "x" }]);
    await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    await app.as(EMILY)("POST", `/api/v1/claims/${id}/approve`, {});
    await app.as(FATMA)("POST", `/api/v1/claims/${id}/approve`, {});
    const b = await app.as(FATMA)("POST", "/api/v1/batches", { method: "transfer", claims: [id] });
    expect(b.body.missingIban).toEqual(["ali@example.com"]);
    const refused = await app.as(FATMA)("POST", `/api/v1/batches/${b.body.id}/send`);
    expect(refused.status).toBe(409);
    expect((await app.as(ALI)("PUT", "/api/v1/me/iban", { iban: "TR33 0006 1005 1978 6457 8413 27" })).status).toBe(422);
    expect((await app.as(ALI)("PUT", "/api/v1/me/iban", { iban: "TR33 0006 1005 1978 6457 8413 26" })).body.iban).toBe("TR33 **** 1326");
    expect((await app.as(FATMA)("POST", `/api/v1/batches/${b.body.id}/send`)).body.state).toBe("sent");
    const csv = await app.as(FATMA)("GET", `/api/v1/batches/${b.body.id}/transfers`);
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="PAY-2026-001-transfers.csv"');
    expect(csv.body).toBe("name;iban;amount;currency;description\r\nAli Demir;TR330006100519786457841326;250,00;TRY;PAY-2026-001 EXP-2026-0001\r\n");
    expect((await app.as(HAKAN)("GET", `/api/v1/batches/${b.body.id}/transfers`)).status).toBe(403);
    expect((await app.as(HAKAN)("GET", `/api/v1/batches/${b.body.id}`)).body.lines[0].iban).toBe("TR33 **** 1326");
  });
});

describe("reports and exports for the accountant", () => {
  it("adds up spending, KDV and what went over policy, and exports items and receipts", async () => {
    const up = await app.upload(ALI, jpeg(9));
    await app.x.readReceipts();
    const id = await claimWith(ALI, [
      { category: "meals", project: "acme", receipt: up.body.id },
      {
        category: "travel",
        date: "2026-10-30",
        amount: 120_000,
        document: "invoice",
        sellerTaxNumber: "1234567890",
        seller: "Pegasus",
        noReceiptReason: "e-ticket",
      },
      { category: "mileage", date: "2026-11-01", km: 100 },
    ]);
    await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    await app.as(EMILY)("POST", `/api/v1/claims/${id}/approve`, {});
    await app.as(FATMA)("POST", `/api/v1/claims/${id}/approve`, {});

    const range = "from=2026-10-01&to=2026-11-30";
    const byCat = (await app.as(HAKAN)("GET", `/api/v1/reports/spend?${range}`)).body;
    expect(byCat.total).toBe(64_000 + 120_000 + 85_000);
    expect(byCat.rows.map((r: any) => [r.key, r.total, r.kdv])).toEqual([
      ["travel", 120_000, 20_000],
      ["mileage", 85_000, 0],
      ["meals", 64_000, 5_818],
    ]);
    const byProject = (await app.as(HAKAN)("GET", `/api/v1/reports/spend?${range}&by=project`)).body;
    expect(byProject.rows.map((r: any) => [r.key, r.name])).toEqual([
      [null, "No project"],
      ["acme", "Acme rollout"],
    ]);
    expect((await app.as(HAKAN)("GET", `/api/v1/reports/spend?${range}&by=department`)).body.rows[0]).toMatchObject({ key: "sales", name: "Sales" });
    expect((await app.as(HAKAN)("GET", "/api/v1/reports/spend?from=2026-12-01&to=2026-11-01")).status).toBe(422);
    expect((await app.as(ALI)("GET", `/api/v1/reports/spend?${range}`)).status).toBe(403);

    const kdv = (await app.as(HAKAN)("GET", `/api/v1/reports/kdv?${range}`)).body;
    expect(kdv.rates).toEqual([
      { rate: 10, base: 58_180, kdv: 5_818, count: 1 },
      { rate: 20, base: 100_000, kdv: 20_000, count: 1 },
    ]);
    const policy = (await app.as(HAKAN)("GET", `/api/v1/reports/policy?${range}`)).body;
    expect(policy.items.map((i: any) => i.flags[0].code)).toEqual(["no-receipt"]);

    const costs = (await app.as("admin")("GET", `/api/v1/project-costs?${range}`)).body;
    expect(costs.projects).toEqual([
      { id: "acme", name: "Acme rollout", total: 64_000, kdv: 5_818, net: 58_182, count: 1, categories: [{ id: "meals", name: "Meals", amount: 64_000 }] },
    ]);

    const csv = await app.as(HAKAN)("GET", `/api/v1/exports/items?${range}`);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const lines = (csv.body as string).replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe(
      "claim;state;person;email;employee_id;department;date;category;account;project;kind;description;seller;seller_tax_number;document;document_number;currency;amount;rate;rate_day;amount_try;kdv_0;kdv_1;kdv_10;kdv_20;kdv;net;paid_by;reimbursable;held;km;days;country;flags;batch;paid_at;receipt_file",
    );
    expect(lines[1]).toBe(
      "EXP-2026-0001;approved;Ali Demir;ali@example.com;1042;Sales;2026-10-30;Meals;770.02;acme;receipt;;Kuzu Lokantası;;receipt;;TRY;640,00;;;640,00;;;58,18;;58,18;581,82;employee;640,00;0,00;;;;;;;EXP-2026-0001/01-2026-10-30-kuzu-lokantasi.jpg",
    );
    expect(lines).toHaveLength(4);
    const zipRes = await app.as(HAKAN)("GET", `/api/v1/exports/receipts?${range}`);
    expect(zipRes.headers.get("content-type")).toBe("application/zip");
    expect(unzip(zipRes.body as Buffer).map((f) => f.name)).toEqual(["EXP-2026-0001/01-2026-10-30-kuzu-lokantasi.jpg"]);
  });
});

describe("people and projects from HR and Time", () => {
  it("reads people, departments and managers from HR, and projects from Time", async () => {
    await app.close();
    app = await startApp({ settings: LINKED });
    // As HR's GET /api/v1/employees answers (hr/openapi.json, Employee): the manager by id, the department with its name.
    app.fakes.state.hr.employees = [
      {
        id: "e-1",
        name: "Ali Demir",
        firstName: "Ali",
        lastName: "Demir",
        preferredName: null,
        workEmail: "ali@example.com",
        status: "active",
        startDate: "2024-02-01",
        department: { id: "d-7", name: "Engineering" },
        position: null,
        manager: { id: "e-2", name: "Selin Aydın" },
        location: null,
        reports: 0,
        parts: [],
      },
      { id: "e-2", name: "Selin Aydın", workEmail: "selin@example.com", status: "active", department: { id: "d-1", name: "Finance" }, manager: null },
      { id: "e-3", name: "Emily Clark", workEmail: null, status: "upcoming", department: null, manager: null },
    ];
    app.fakes.state.time.projects = [
      { id: "p1", code: "ACME-1", name: "Acme rollout", status: "active" },
      { id: "p2", name: "Old", archived: true },
    ];
    await app.x.tick();
    expect(app.fakes.state.hr.hits).toEqual(["?status=current"]);
    const people = (await app.as(HAKAN)("GET", "/api/v1/people")).body.people;
    expect(people).toEqual([
      {
        email: "ali@example.com",
        name: "Ali Demir",
        employeeId: "e-1",
        department: { id: "engineering", name: "Engineering" },
        manager: "selin@example.com",
        source: "hr",
        member: true,
      },
      {
        email: "selin@example.com",
        name: "Selin Aydın",
        employeeId: "e-2",
        department: { id: "d-1", name: "Finance" },
        manager: null,
        source: "hr",
        member: true,
      },
    ]);
    expect((await app.as(ALI)("GET", "/api/v1/projects")).body.projects).toEqual([{ id: "ACME-1", name: "Acme rollout" }]);
    // Engineering's chain: Ali's manager from HR, then Selin over 20,000 TL.
    const id = await claimWith(ALI, [{ category: "travel", project: "ACME-1", date: "2026-10-30", amount: 2_500_000, noReceiptReason: "x" }]);
    const sent = await app.as(ALI)("POST", `/api/v1/claims/${id}/submit`);
    expect(sent.body.steps.map((s: any) => s.approver?.email ?? "finance")).toEqual(["selin@example.com", "finance"]);
    const integ = (await app.as(HAKAN)("GET", "/api/v1/integrations")).body;
    expect(integ.hr).toMatchObject({ configured: true, error: null, people: 2 });
    expect(integ.time).toMatchObject({ configured: true, projects: 1 });

    // HR down: the people last read stay.
    app.fakes.state.hr.status = 500;
    app.clock.advance(16 * 60_000);
    await app.x.tick();
    expect((await app.as(HAKAN)("GET", "/api/v1/integrations")).body.hr.error).toContain("HR answered 500");
    expect((await app.as(HAKAN)("GET", "/api/v1/people")).body.people).toHaveLength(2);
  });
});
