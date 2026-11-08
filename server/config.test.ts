import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configWarnings, parseConfig, watchConfig } from "./config.ts";
import { SETTINGS } from "./test-app.ts";

const fail = (yaml: string) => {
  try {
    parseConfig(yaml);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("the file was taken");
};

describe("the settings file", () => {
  it("has defaults that need nothing written", () => {
    const c = parseConfig("");
    expect(c.timeZone).toBe("Europe/Istanbul");
    expect(c.categories.map((x) => x.id)).toEqual(["travel", "meals", "other"]);
    expect(c.approvals.chain).toEqual([{ approver: "manager", over: 0 }]);
    expect(c.rates).toEqual({ url: "https://www.tcmb.gov.tr/kurlar", kind: "forex_buying", day: "previous" });
    expect(c.receipts.maxSize).toBe(10 * 1024 * 1024);
    expect(c.receipts.types).toEqual(["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"]);
    expect(c.kdvRates).toEqual([0, 1, 10, 20]);
    expect(c.exports).toEqual({ separator: ";", decimal: "," });
  });

  it("reads the example file in config/", () => {
    const c = parseConfig(readFileSync(new URL("../config/expenses.yaml", import.meta.url), "utf8"));
    expect(c.categories.length).toBeGreaterThan(3);
  });

  it("reads limits, mileage and daily allowances in kuruş and their currency", () => {
    const c = parseConfig(SETTINGS.replaceAll("FAKES", "http://fakes:8080"));
    const meals = c.categories.find((x) => x.id === "meals")!;
    expect(meals).toMatchObject({ kind: "receipt", account: "770.02", kdv: 10, limits: { perItem: null, perDay: 75_000, perMonth: null }, overLimit: "flag" });
    expect(c.categories.find((x) => x.id === "mileage")).toMatchObject({ kind: "mileage", perKm: 850, kdv: null });
    expect(c.categories.find((x) => x.id === "per-diem")!.perDay).toEqual({
      TR: { amount: 60_000, currency: "TRY" },
      DE: { amount: 6_000, currency: "EUR" },
      default: { amount: 5_000, currency: "EUR" },
    });
    expect(c.approvals.chain).toEqual([
      { approver: "manager", over: 0 },
      { approver: "finance", over: 1_000_000 },
      { approver: "hakan@example.com", over: 5_000_000 },
    ]);
    expect(c.approvals.departments.engineering).toHaveLength(2);
    expect(c.people.find((p) => p.email === "ali@example.com")).toEqual({
      email: "ali@example.com",
      name: "Ali Demir",
      employeeId: "1042",
      department: "sales",
      manager: "emily@example.com",
    });
    expect(c.cards.holders).toEqual({ "4417": "ali@example.com", "9001": "deniz@example.com" });
    expect(c.currencies).toEqual(["EUR", "USD", "GBP", "JPY"]);
  });

  it("says what is wrong, at the field", () => {
    expect(fail("nope: 1")).toContain("The file: unknown nope");
    expect(fail("categories: { meals: { limit: { per_day: lots } } }")).toContain("categories.meals.limit.per_day is an amount in TRY");
    expect(fail("categories: { meals: { limit: { per_day: 50 EUR } } }")).toContain("categories.meals.limit.per_day is an amount in TRY");
    expect(fail("categories: { car: { kind: mileage } }")).toContain("categories.car.rate is the amount paid per kilometre");
    expect(fail("categories: { car: { kind: mileage, rate: 8, kdv: 20% } }")).toContain("carry no KDV");
    expect(fail("categories: { meals: { kdv: 8% } }")).toContain("8% is not in kdv_rates");
    expect(fail("categories: { away: { kind: per_diem, rates: { Germany: 60 EUR } } }")).toContain("a country is a two-letter code");
    expect(fail("categories: { meals: { over_limit: warn } }")).toContain("over_limit is flag");
    expect(fail("approvals: { chain: [boss] }")).toContain("approvals.chain[0].approver is manager, finance or a member's email");
    expect(fail("approvals: { departments: { sales: [manager] } }")).toContain("sales is not under departments");
    expect(fail("people: { a@example.com: { manager: a@example.com } }")).toContain("nobody is their own manager");
    expect(fail("people: { a@example.com: { department: ops } }")).toContain("ops is not under departments");
    expect(fail("rates: { use: average }")).toContain("rates.use is forex_buying");
    expect(fail("rates: { day: next }")).toContain("rates.day is previous");
    expect(fail("receipts: { max_size: 1GB }")).toContain("receipts.max_size is a size");
    expect(fail("receipts: { types: [gif] }")).toContain("gif is not one of jpeg");
    expect(fail("currencies: [EUR, XYZ]")).toContain("XYZ is not an ISO 4217");
    expect(fail("cards: { holders: { 44: a@example.com } }")).toContain("last four digits");
    expect(fail("exports: { separator: ',', decimal: ',' }")).toContain("must differ");
    expect(fail("hr: { url: http://hr.example.com }")).toContain("hr.url is an https:// address");
    expect(fail("hr: { url: https://hr.example.com, token: secret-value }")).toContain("never the secret itself");
    expect(fail("time_zone: Mars/Base")).toContain("not a time zone");
    expect(fail("[")).toContain("Not valid YAML");
  });

  it("warns about what does not stop it: secrets not set, approvers and holders who are not members", () => {
    const c = parseConfig(SETTINGS.replaceAll("FAKES", "http://fakes:8080"));
    const w = configWarnings(c, {}, ["ali@example.com", "emily@example.com", "hakan@example.com"]);
    expect(w).toContain("receipts.reader: READER_TOKEN is not set, so receipts are not read.");
    expect(w).toContain("approvals: selin@example.com is not a member of Expenses.");
    expect(w).toContain("people.deniz@example.com.manager: can@example.com is not a member of Expenses.");
    expect(w).toContain("cards.holders.9001: deniz@example.com is not a member of Expenses.");
  });

  it("keeps the last good file when a change has a mistake, and takes the next good one", () => {
    const dir = mkdtempSync(join(tmpdir(), "expenses-config-"));
    const path = join(dir, "expenses.yaml");
    writeFileSync(path, "categories: { meals: { name: Meals } }\n");
    const applied: string[] = [];
    const w = watchConfig(path, (c) => (applied.push(c.categories.map((x) => x.id).join(",")), []), { everyMs: 60_000 });
    expect(applied).toEqual(["meals"]);
    writeFileSync(path, "categories: { meals: { over_limit: maybe } }\n");
    w.read();
    expect(w.state.error).toContain("over_limit");
    expect(applied).toEqual(["meals"]);
    writeFileSync(path, "categories: { meals: {}, taxi: {} }\n");
    w.read();
    expect(w.state.error).toBeNull();
    expect(applied).toEqual(["meals", "meals,taxi"]);
    w.stop();
  });
});
