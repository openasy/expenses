import { describe, expect, it } from "vitest";
import { planChain } from "./approvals.ts";
import { parseConfig } from "./config.ts";
import { csvLine, csvText, parseCsv, parseDay } from "./csv.ts";
import { readFieldsFrom, readHrPerson } from "./links.ts";
import { checkItems, sellerKey, type PolicyItem } from "./policy.ts";
import { sniff, unsafePdf } from "./sniff.ts";
import { tcmbXml } from "./fakes.ts";
import { parseTcmb, tcmbUrl } from "./tcmb.ts";
import { SETTINGS } from "./test-app.ts";
import { unzip, zip } from "./zip.ts";

const config = parseConfig(SETTINGS.replaceAll("FAKES", "http://fakes:8080"));
const none = { day: () => 0, month: () => 0 };
const item = (o: Partial<PolicyItem>): PolicyItem => ({
  id: "i1",
  kind: "receipt",
  category: "travel",
  project: null,
  date: "2026-10-30",
  amountTry: 50_000,
  paidBy: "employee",
  hasReceipt: true,
  noReceiptReason: null,
  lookalikes: [],
  differs: [],
  ...o,
});

describe("the policy", () => {
  it("passes an item within its limits", () => {
    expect(checkItems(config, [item({})], none, "2026-11-02").get("i1")).toEqual({ flags: [], held: 0 });
  });

  it("counts a day's limit over this claim and what was spent in others", () => {
    const r = checkItems(
      config,
      [item({ id: "a", category: "meals", amountTry: 40_000 }), item({ id: "b", category: "meals", amountTry: 30_000 })],
      { day: () => 10_000, month: () => 0 },
      "2026-11-02",
    );
    expect(r.get("a")!.flags).toEqual([]);
    expect(r.get("b")!.flags[0]).toMatchObject({ code: "over-limit", finance: true, blocks: false });
    expect(r.get("b")!.flags[0]!.text).toBe("800.00 TRY on 2026-10-30 is over Meals's limit of 750.00 TRY a day.");
  });

  it("caps what is paid back, blocks, or asks finance, as the category says", () => {
    const capped = checkItems(config, [item({ category: "hotel", amountTry: 620_000 })], none, "2026-11-02").get("i1")!;
    expect(capped.held).toBe(120_000);
    expect(capped.flags[0]).toMatchObject({ finance: false, blocks: false });
    const cardPaid = checkItems(config, [item({ category: "hotel", amountTry: 620_000, paidBy: "company" })], none, "2026-11-02").get("i1")!;
    expect(cardPaid).toMatchObject({ held: 0, flags: [{ finance: true }] });
    const blocked = checkItems(config, [item({ category: "gifts", amountTry: 150_000 })], none, "2026-11-02").get("i1")!;
    expect(blocked.flags[0]).toMatchObject({ code: "over-limit", blocks: true });
  });

  it("flags a missing receipt, late receipts, duplicates and what reads otherwise", () => {
    const r = checkItems(
      config,
      [
        item({ id: "a", hasReceipt: false }),
        item({ id: "b", hasReceipt: false, noReceiptReason: "The taxi had no printer." }),
        item({ id: "c", date: "2026-07-01" }),
        item({ id: "d", lookalikes: [{ claim: "EXP-2026-0001", item: "x", sameFile: false }] }),
        item({ id: "e", differs: ["amount"] }),
      ],
      none,
      "2026-11-02",
    );
    expect(r.get("a")!.flags[0]).toMatchObject({ code: "no-receipt", finance: true, blocks: true });
    expect(r.get("b")!.flags[0]).toMatchObject({ code: "no-receipt", finance: true, blocks: false, text: "No receipt: The taxi had no printer." });
    expect(r.get("c")!.flags[0]).toMatchObject({ code: "late", finance: true });
    expect(r.get("d")!.flags[0]).toMatchObject({ code: "duplicate", finance: true, of: { claim: "EXP-2026-0001", item: "x" } });
    expect(r.get("e")!.flags[0]).toMatchObject({ code: "receipt-differs", finance: false });
  });

  it("compares sellers without case, punctuation or the company form", () => {
    expect(sellerKey("Kuzu Lokantası Ltd. Şti.")).toBe(sellerKey("KUZU LOKANTASI"));
    expect(sellerKey("İstanbul Taksi A.Ş.")).toBe("istanbultaksi");
    expect(sellerKey("...")).toBeNull();
  });
});

describe("the approval chain", () => {
  const plan = (o: { owner?: string; department?: string | null; total: number }, manager: string | null, reasons: string[] = []) =>
    planChain(config, { ownerEmail: o.owner ?? "ali@example.com", department: o.department ?? "sales", total: o.total }, manager, reasons).map(
      (s) => s.approver ?? "finance",
    );

  it("adds steps by the total", () => {
    expect(plan({ total: 64_000 }, "emily@example.com")).toEqual(["emily@example.com"]);
    expect(plan({ total: 1_000_000 }, "emily@example.com")).toEqual(["emily@example.com"]);
    expect(plan({ total: 1_000_001 }, "emily@example.com")).toEqual(["emily@example.com", "finance"]);
    expect(plan({ total: 6_000_000 }, "emily@example.com")).toEqual(["emily@example.com", "finance", "hakan@example.com"]);
  });

  it("follows the department's own chain", () => {
    expect(plan({ owner: "deniz@example.com", department: "engineering", total: 2_500_000 }, "can@example.com")).toEqual([
      "can@example.com",
      "selin@example.com",
    ]);
  });

  it("goes to finance without a manager, never to the claimant, and once per person", () => {
    expect(plan({ total: 100 }, null)).toEqual(["finance"]);
    expect(plan({ owner: "hakan@example.com", total: 6_000_000 }, "emily@example.com")).toEqual(["emily@example.com", "finance"]);
    expect(plan({ total: 6_000_000 }, "hakan@example.com")).toEqual(["hakan@example.com", "finance"]);
  });

  it("adds finance for what the policy flags", () => {
    expect(plan({ total: 100 }, "emily@example.com", ["an item without a receipt"])).toEqual(["emily@example.com", "finance"]);
  });
});

describe("TCMB's files", () => {
  it("reads each currency per unit and the day", () => {
    const xml = tcmbXml("2026-10-28", { USD: { forexBuying: "42.1234", forexSelling: "42.2000" }, JPY: { unit: 100, forexBuying: "27.8000" } });
    const r = parseTcmb(xml)!;
    expect(r.day).toBe("2026-10-28");
    expect(r.rates.get("USD")).toEqual({ forex_buying: 42_123_400, forex_selling: 42_200_000, banknote_buying: null, banknote_selling: null });
    expect(r.rates.get("JPY")!.forex_buying).toBe(278_000);
    expect(parseTcmb("<html>")).toBeNull();
    expect(tcmbUrl("https://www.tcmb.gov.tr/kurlar", "2026-10-28")).toBe("https://www.tcmb.gov.tr/kurlar/202610/28102026.xml");
  });
});

describe("files", () => {
  it("knows a receipt's type from its bytes", () => {
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniff(Buffer.from("....ftypheic....", "latin1"))).toBe("image/heic");
    expect(sniff(Buffer.from("%PDF-1.7\n........", "latin1"))).toBe("application/pdf");
    expect(sniff(Buffer.from("<html><script>x</script></html>"))).toBeNull();
    expect(sniff(Buffer.from("GIF89a......"))).toBeNull();
  });

  it("refuses PDFs that run scripts or launch files, however the name is written", () => {
    expect(unsafePdf(Buffer.from("%PDF-1.4 << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"))).toContain("scripts");
    expect(unsafePdf(Buffer.from("%PDF-1.4 << /S /Java#53cript >>"))).toContain("scripts");
    expect(unsafePdf(Buffer.from("%PDF-1.4 << /S /Launch >>"))).toContain("launches");
    expect(unsafePdf(Buffer.from("%PDF-1.4 << /Type /Catalog >>"))).toBeNull();
  });

  it("writes a ZIP that reads back", () => {
    const files = [
      { name: "EXP-2026-0001/01-2026-10-30-kuzu.jpg", data: Buffer.from("one"), at: new Date("2026-11-02T06:00:00Z") },
      { name: "EXP-2026-0002/01-2026-10-31-ş.pdf", data: Buffer.alloc(5000, 7), at: new Date("2026-11-02T06:00:00Z") },
    ];
    expect(unzip(zip(files)).map((f) => [f.name, f.data.length])).toEqual([
      ["EXP-2026-0001/01-2026-10-30-kuzu.jpg", 3],
      ["EXP-2026-0002/01-2026-10-31-ş.pdf", 5000],
    ]);
  });

  it("reads statements and writes CSV a spreadsheet will not run", () => {
    expect(parseCsv('﻿Tarih;Açıklama;Tutar\n28.10.2026;"KUZU; LOKANTA";640,00\n')).toEqual([
      ["Tarih", "Açıklama", "Tutar"],
      ["28.10.2026", "KUZU; LOKANTA", "640,00"],
    ]);
    expect(parseCsv("Garanti BBVA\nDönem;Ekim\nTarih;Tutar\n28.10.2026;1,5")[3]).toEqual(["28.10.2026", "1,5"]);
    expect([...Buffer.from(csvText([["a"]], ";")).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(parseDay("28.10.2026 14:05")).toBe("2026-10-28");
    expect(parseDay("28/10/26")).toBe("2026-10-28");
    expect(parseDay("31.02.2026")).toBeNull();
    expect(csvLine(["=SUM(A1)", "-12,50", "a;b", 'say "hi"', null, 5], ";")).toBe(`'=SUM(A1);-12,50;"a;b";"say ""hi""";;5`);
  });
});

describe("what other services answer", () => {
  it("reads HR's people however a department and a manager are written", () => {
    expect(
      readHrPerson({
        email: "Ali@Example.com",
        name: "Ali Demir",
        employeeId: 1042,
        department: { id: "sales", name: "Sales" },
        manager: { email: "emily@example.com" },
      }),
    ).toEqual({
      email: "ali@example.com",
      name: "Ali Demir",
      employeeId: "1042",
      department: "sales",
      departmentName: "Sales",
      manager: "emily@example.com",
      active: true,
    });
    expect(
      readHrPerson({ email: "x@example.com", firstName: "X", lastName: "Y", department: "Finans", managerEmail: "x@example.com", status: "left" }),
    ).toMatchObject({
      name: "X Y",
      department: "Finans",
      manager: null,
      active: false,
    });
    expect(readHrPerson({ name: "No email" })).toBeNull();
  });

  it("reads a receipt reader's answer in minor units, leaving out what is not its type", () => {
    expect(
      readFieldsFrom({
        confidence: 0.9,
        amount: "640.00",
        currency: "try",
        date: "2026-10-30",
        seller: "Kuzu",
        vat: [{ rate: 10, amount: "58.18" }, { rate: "x" }],
      }),
    ).toEqual({
      confidence: 0.9,
      amount: 64_000,
      currency: "TRY",
      date: "2026-10-30",
      seller: "Kuzu",
      sellerTaxNumber: null,
      documentNumber: null,
      vat: [{ rate: 10, amount: 5_818 }],
    });
    expect(readFieldsFrom({ total: 1200, currency: "JPY", date: "30.10.2026", taxNumber: "123" })).toMatchObject({
      amount: 1200,
      date: null,
      sellerTaxNumber: null,
    });
  });
});
