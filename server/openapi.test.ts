import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import type { Actor } from "./store.ts";
import { ADMIN_TOKEN, ALI, DENIZ, EMILY, FATMA, HAKAN, jpeg, PDF, startApp, tokenOf, type TestApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "expenses-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: TestApp;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});
afterAll(() => app.close());

const BINARY = ["application/zip", "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"];

async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (BINARY.includes(type)) return { res, body: Buffer.from(await res.arrayBuffer()) as any };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const as = (who: Actor | "admin", b?: unknown) => ({
  headers: { authorization: `Bearer ${who === "admin" ? ADMIN_TOKEN : tokenOf(who)}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});
const anon = (b?: unknown) => ({ headers: { "content-type": "application/json" }, ...(b !== undefined && { body: JSON.stringify(b) }) });
const raw = (who: Actor, data: Buffer, type: string, name = "receipt") => ({
  headers: { authorization: `Bearer ${tokenOf(who)}`, "content-type": type, "x-file-name": name },
  body: new Uint8Array(data),
});

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    for (const p of ["/api/v1/products", "/api/v1/me", "/api/v1/summary", "/api/v1/policy", "/api/v1/projects"]) {
      await call("GET", p, as(ALI));
      await call("GET", p, {});
    }
    await call("GET", "/api/v1/summary", as(HAKAN));
    for (const p of ["/api/v1/settings", "/api/v1/integrations", "/api/v1/people"]) {
      await call("GET", p, as(HAKAN));
      await call("GET", p, as(ALI));
    }
    await call("PUT", "/api/v1/me/iban", as(ALI, { iban: "TR33 0006 1005 1978 6457 8413 26" }));
    await call("PUT", "/api/v1/me/iban", as(ALI, { iban: "TR00" }));
    await call("PUT", "/api/v1/me/iban", as("admin", { iban: null }));
    await call("GET", "/api/v1/rates", as(ALI), "/api/v1/rates?currency=EUR&date=2026-10-30");
    await call("GET", "/api/v1/rates", as(ALI), "/api/v1/rates?currency=XXX");
    app.fakes.state.tcmb.status = 503;
    await call("GET", "/api/v1/rates", as(ALI), "/api/v1/rates?currency=USD&date=2026-10-20");
    app.fakes.state.tcmb.status = 0;
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("receipts", async () => {
    const up = await call("POST", "/api/v1/receipts", raw(ALI, jpeg(1), "image/jpeg", "lunch.jpg"));
    ids.receipt = up.body.id;
    await call("POST", "/api/v1/receipts", raw(ALI, jpeg(1), "image/jpeg"));
    ids.pdf = (await call("POST", "/api/v1/receipts", raw(ALI, PDF, "application/pdf", "fatura.pdf"))).body.id;
    await call("POST", "/api/v1/receipts", raw(ALI, Buffer.from("<html>"), "text/html"));
    await call("POST", "/api/v1/receipts", raw(ALI, Buffer.alloc(0), "image/jpeg"));
    await call("POST", "/api/v1/receipts", raw(ALI, Buffer.alloc(2 * 1024 * 1024, 0xff), "image/jpeg"));
    await call("POST", "/api/v1/receipts", { body: new Uint8Array(jpeg(2)), headers: { "content-type": "image/jpeg" } });
    await app.x.readReceipts();
    await call("GET", "/api/v1/receipts/{id}", as(ALI), `/api/v1/receipts/${ids.receipt}`);
    await call("GET", "/api/v1/receipts/{id}", as(DENIZ), `/api/v1/receipts/${ids.receipt}`);
    await call("GET", "/api/v1/receipts/{id}/file", as(ALI), `/api/v1/receipts/${ids.receipt}/file`);
    await call("GET", "/api/v1/receipts/{id}/file", as(ALI), `/api/v1/receipts/${ids.pdf}/file`);
    await call("GET", "/api/v1/receipts/{id}/file", as(DENIZ), `/api/v1/receipts/${ids.receipt}/file`);
    const spare = (await call("POST", "/api/v1/receipts", raw(ALI, jpeg(3), "image/jpeg"))).body.id;
    await call("DELETE", "/api/v1/receipts/{id}", as(ALI), `/api/v1/receipts/${spare}`);
    await call("DELETE", "/api/v1/receipts/{id}", as(ALI), `/api/v1/receipts/${spare}`);
  });

  it("claims and items", async () => {
    ids.claim = (await call("POST", "/api/v1/claims", as(ALI, { title: "Acme visit" }))).body.id;
    await call("POST", "/api/v1/claims", as(ALI, { title: "" }));
    await call("POST", "/api/v1/claims", as(ALI, "{"));
    await call("POST", "/api/v1/claims", as("admin", { title: "x" }));
    await call("GET", "/api/v1/claims", as(ALI));
    await call("GET", "/api/v1/claims", as(ALI), "/api/v1/claims?scope=all");
    await call("GET", "/api/v1/claims", as(HAKAN), "/api/v1/claims?scope=all&state=draft,submitted&q=acme");
    await call("GET", "/api/v1/claims", as(ALI), "/api/v1/claims?state=maybe");
    await call("PATCH", "/api/v1/claims/{id}", as(ALI, { title: "Acme visit, 30 October" }), `/api/v1/claims/${ids.claim}`);
    await call("PATCH", "/api/v1/claims/{id}", as(ALI, { title: 5 }), `/api/v1/claims/${ids.claim}`);
    await call("PATCH", "/api/v1/claims/{id}", as(HAKAN, { title: "x" }), `/api/v1/claims/${ids.claim}`);
    await call("PATCH", "/api/v1/claims/{id}", as(ALI, {}), "/api/v1/claims/missing");

    ids.item = (
      await call(
        "POST",
        "/api/v1/claims/{id}/items",
        as(ALI, { category: "meals", project: "acme", receipt: ids.receipt }),
        `/api/v1/claims/${ids.claim}/items`,
      )
    ).body.id;
    await call(
      "POST",
      "/api/v1/claims/{id}/items",
      as(ALI, { category: "hotel", date: "2026-10-30", currency: "EUR", amount: 9_000, noReceiptReason: "Emailed." }),
      `/api/v1/claims/${ids.claim}/items`,
    );
    await call("POST", "/api/v1/claims/{id}/items", as(ALI, { category: "mileage", date: "2026-10-30", km: 42.5 }), `/api/v1/claims/${ids.claim}/items`);
    await call("POST", "/api/v1/claims/{id}/items", as(ALI, { category: "nope" }), `/api/v1/claims/${ids.claim}/items`);
    await call("POST", "/api/v1/claims/{id}/items", as(ALI, "{"), `/api/v1/claims/${ids.claim}/items`);
    await call("POST", "/api/v1/claims/{id}/items", as(EMILY, { category: "meals" }), `/api/v1/claims/${ids.claim}/items`);
    await call("POST", "/api/v1/claims/{id}/items", as(ALI, { category: "meals" }), "/api/v1/claims/missing/items");
    await call("GET", "/api/v1/items/{id}", as(ALI), `/api/v1/items/${ids.item}`);
    await call("GET", "/api/v1/items/{id}", as(DENIZ), `/api/v1/items/${ids.item}`);
    await call("PATCH", "/api/v1/items/{id}", as(ALI, { description: "Lunch with Acme's team" }), `/api/v1/items/${ids.item}`);
    await call("PATCH", "/api/v1/items/{id}", as(ALI, { amount: -1 }), `/api/v1/items/${ids.item}`);
    await call("PATCH", "/api/v1/items/{id}", as(ALI, {}), "/api/v1/items/missing");
    const extra = (
      await call(
        "POST",
        "/api/v1/claims/{id}/items",
        as(ALI, { category: "travel", date: "2026-10-30", amount: 100, noReceiptReason: "x" }),
        `/api/v1/claims/${ids.claim}/items`,
      )
    ).body.id;
    await call("DELETE", "/api/v1/items/{id}", as(ALI), `/api/v1/items/${extra}`);
    await call("DELETE", "/api/v1/items/{id}", as(ALI), `/api/v1/items/${extra}`);
    await call("GET", "/api/v1/claims/{id}", as(ALI), `/api/v1/claims/${ids.claim}`);
    await call("GET", "/api/v1/claims/{id}", as(DENIZ), `/api/v1/claims/${ids.claim}`);

    const empty = (await call("POST", "/api/v1/claims", as(ALI, { title: "Nothing" }))).body.id;
    await call("POST", "/api/v1/claims/{id}/submit", as(ALI), `/api/v1/claims/${empty}/submit`);
    await call("DELETE", "/api/v1/claims/{id}", as(ALI), `/api/v1/claims/${empty}`);
    await call("DELETE", "/api/v1/claims/{id}", as(ALI), `/api/v1/claims/${empty}`);
  });

  it("approvals", async () => {
    await call("POST", "/api/v1/claims/{id}/submit", as(ALI), `/api/v1/claims/${ids.claim}/submit`);
    await call("POST", "/api/v1/claims/{id}/submit", as(ALI), `/api/v1/claims/${ids.claim}/submit`);
    await call("POST", "/api/v1/claims/{id}/submit", as(ALI), "/api/v1/claims/missing/submit");
    await call("PATCH", "/api/v1/claims/{id}", as(ALI, { title: "x" }), `/api/v1/claims/${ids.claim}`);
    await call("DELETE", "/api/v1/claims/{id}", as(ALI), `/api/v1/claims/${ids.claim}`);
    await call("DELETE", "/api/v1/items/{id}", as(ALI), `/api/v1/items/${ids.item}`);
    await call("PATCH", "/api/v1/items/{id}", as(ALI, { description: "x" }), `/api/v1/items/${ids.item}`);
    await call("POST", "/api/v1/claims/{id}/items", as(ALI, { category: "meals" }), `/api/v1/claims/${ids.claim}/items`);
    await call("POST", "/api/v1/claims/{id}/withdraw", as(ALI), `/api/v1/claims/${ids.claim}/withdraw`);
    await call("POST", "/api/v1/claims/{id}/withdraw", as(ALI), `/api/v1/claims/${ids.claim}/withdraw`);
    await call("POST", "/api/v1/claims/{id}/withdraw", as(ALI), "/api/v1/claims/missing/withdraw");
    await call("POST", "/api/v1/claims/{id}/submit", as(ALI), `/api/v1/claims/${ids.claim}/submit`);

    await call("POST", "/api/v1/claims/{id}/approve", as(ALI, {}), `/api/v1/claims/${ids.claim}/approve`);
    await call("POST", "/api/v1/claims/{id}/approve", as(EMILY, { comment: 5 }), `/api/v1/claims/${ids.claim}/approve`);
    await call("POST", "/api/v1/claims/{id}/approve", as(EMILY, {}), "/api/v1/claims/missing/approve");
    await call("POST", "/api/v1/claims/{id}/reject", as(EMILY, {}), `/api/v1/claims/${ids.claim}/reject`);
    await call("POST", "/api/v1/claims/{id}/reassign", as(FATMA, { to: "nobody@example.com" }), `/api/v1/claims/${ids.claim}/reassign`);
    await call("POST", "/api/v1/claims/{id}/reassign", as(FATMA, { to: "emily@example.com" }), "/api/v1/claims/missing/reassign");
    await call("POST", "/api/v1/claims/{id}/reassign", as(EMILY, { to: "hakan@example.com" }), `/api/v1/claims/${ids.claim}/reassign`);
    await call(
      "POST",
      "/api/v1/claims/{id}/reassign",
      as(FATMA, { to: "emily@example.com", comment: "Back to Emily" }),
      `/api/v1/claims/${ids.claim}/reassign`,
    );
    await call("POST", "/api/v1/claims/{id}/approve", as(EMILY, { comment: "OK" }), `/api/v1/claims/${ids.claim}/approve`);
    await call("POST", "/api/v1/claims/{id}/approve", as(FATMA, {}), `/api/v1/claims/${ids.claim}/approve`);
    await call("POST", "/api/v1/claims/{id}/approve", as(FATMA, {}), `/api/v1/claims/${ids.claim}/approve`);
    await call("POST", "/api/v1/claims/{id}/reassign", as(FATMA, { to: "emily@example.com" }), `/api/v1/claims/${ids.claim}/reassign`);
    await call("GET", "/api/v1/claims", as(EMILY), "/api/v1/claims?scope=decided");

    // Sent back, and rejected.
    const back = (await call("POST", "/api/v1/claims", as(ALI, { title: "Taxi" }))).body.id;
    await call(
      "POST",
      "/api/v1/claims/{id}/items",
      as(ALI, { category: "travel", date: "2026-10-30", amount: 25_000, noReceiptReason: "x" }),
      `/api/v1/claims/${back}/items`,
    );
    await call("POST", "/api/v1/claims/{id}/submit", as(ALI), `/api/v1/claims/${back}/submit`);
    await call("GET", "/api/v1/claims", as(EMILY), "/api/v1/claims?scope=approvals");
    await call("POST", "/api/v1/claims/{id}/return", as(EMILY, {}), `/api/v1/claims/${back}/return`);
    await call("POST", "/api/v1/claims/{id}/return", as(EMILY, { comment: "Which customer?" }), `/api/v1/claims/${back}/return`);
    await call("POST", "/api/v1/claims/{id}/return", as(EMILY, { comment: "x" }), "/api/v1/claims/missing/return");
    await call("POST", "/api/v1/claims/{id}/return", as(EMILY, { comment: "x" }), `/api/v1/claims/${back}/return`);
    await call("POST", "/api/v1/claims/{id}/submit", as(ALI), `/api/v1/claims/${back}/submit`);
    await call("POST", "/api/v1/claims/{id}/reject", as(EMILY, { comment: "Not a business trip." }), `/api/v1/claims/${back}/reject`);
    await call("POST", "/api/v1/claims/{id}/reject", as(EMILY, { comment: "x" }), "/api/v1/claims/missing/reject");
    await call("POST", "/api/v1/claims/{id}/reject", as(EMILY, { comment: "x" }), `/api/v1/claims/${back}/reject`);
  });

  it("paying back", async () => {
    await call("GET", "/api/v1/batches", as(HAKAN));
    await call("GET", "/api/v1/batches", as(HAKAN), "/api/v1/batches?state=lost");
    await call("POST", "/api/v1/batches", as(FATMA, { method: "cash" }));
    await call("POST", "/api/v1/batches", as(FATMA, { method: "payroll", claims: ["missing"] }));
    ids.batch = (await call("POST", "/api/v1/batches", as(FATMA, { method: "transfer", payDate: "2026-11-30" }))).body.id;
    await call("POST", "/api/v1/batches", as(FATMA, { method: "payroll" }));
    await call("GET", "/api/v1/batches/{id}", as(HAKAN), `/api/v1/batches/${ids.batch}`);
    await call("GET", "/api/v1/batches/{id}", as(HAKAN), "/api/v1/batches/missing");
    await call("PATCH", "/api/v1/batches/{id}", as(FATMA, { payDate: "2026-11-28" }), `/api/v1/batches/${ids.batch}`);
    await call("PATCH", "/api/v1/batches/{id}", as(FATMA, { remove: [ids.claim] }), `/api/v1/batches/${ids.batch}`);
    await call("PATCH", "/api/v1/batches/{id}", as(FATMA, { remove: [ids.claim] }), `/api/v1/batches/${ids.batch}`);
    await call("PATCH", "/api/v1/batches/{id}", as(FATMA, { add: [ids.claim] }), `/api/v1/batches/${ids.batch}`);
    await call("PATCH", "/api/v1/batches/{id}", as(FATMA, {}), "/api/v1/batches/missing");
    await call("POST", "/api/v1/batches/{id}/paid", as(FATMA, {}), `/api/v1/batches/${ids.batch}/paid`);
    await call("POST", "/api/v1/batches/{id}/send", as(FATMA), `/api/v1/batches/${ids.batch}/send`);
    await call("POST", "/api/v1/batches/{id}/send", as(FATMA), `/api/v1/batches/${ids.batch}/send`);
    await call("POST", "/api/v1/batches/{id}/send", as(FATMA), "/api/v1/batches/missing/send");
    await call("PATCH", "/api/v1/batches/{id}", as(FATMA, { payDate: "2026-11-29" }), `/api/v1/batches/${ids.batch}`);
    await call("DELETE", "/api/v1/batches/{id}", as(FATMA), `/api/v1/batches/${ids.batch}`);
    await call("DELETE", "/api/v1/batches/{id}", as(FATMA), "/api/v1/batches/missing");
    await call("GET", "/api/v1/batches/{id}/transfers", as(FATMA), `/api/v1/batches/${ids.batch}/transfers`);
    await call("GET", "/api/v1/batches/{id}/transfers", as(FATMA), "/api/v1/batches/missing/transfers");
    await call("GET", "/api/v1/payroll", as(HAKAN), "/api/v1/payroll?month=2026-11");
    await call("GET", "/api/v1/payroll", as(HAKAN), "/api/v1/payroll?month=11-2026");
    await call("POST", "/api/v1/batches/{id}/paid", as(FATMA, { paidOn: "yesterday" }), `/api/v1/batches/${ids.batch}/paid`);
    await call("POST", "/api/v1/batches/{id}/paid", as(FATMA, { paidOn: "2026-11-28" }), `/api/v1/batches/${ids.batch}/paid`);
    await call("POST", "/api/v1/batches/{id}/paid", as(FATMA, {}), "/api/v1/batches/missing/paid");

    // A payroll batch has no transfer list; an empty one cannot be removed once sent.
    const c = (await call("POST", "/api/v1/claims", as(ALI, { title: "Fuel" }))).body.id;
    await call(
      "POST",
      "/api/v1/claims/{id}/items",
      as(ALI, { category: "travel", date: "2026-10-30", amount: 5_000, noReceiptReason: "x" }),
      `/api/v1/claims/${c}/items`,
    );
    await call("POST", "/api/v1/claims/{id}/submit", as(ALI), `/api/v1/claims/${c}/submit`);
    await call("POST", "/api/v1/claims/{id}/approve", as(EMILY, {}), `/api/v1/claims/${c}/approve`);
    await call("POST", "/api/v1/claims/{id}/approve", as(FATMA, {}), `/api/v1/claims/${c}/approve`);
    const pay = (await call("POST", "/api/v1/batches", as(FATMA, { method: "payroll" }))).body.id;
    await call("GET", "/api/v1/batches/{id}/transfers", as(FATMA), `/api/v1/batches/${pay}/transfers`);
    await call("DELETE", "/api/v1/batches/{id}", as(FATMA), `/api/v1/batches/${pay}`);
  });

  it("company cards", async () => {
    const csv = "İşlem Tarihi;Açıklama;Kart No;Tutar\n30.10.2026;KUZU LOKANTASI;**** 4417;640,00\n31.10.2026;ODEME;**** 4417;-640,00\n";
    await call("POST", "/api/v1/cards/imports", as(FATMA, { csv, check: true }));
    await call("POST", "/api/v1/cards/imports", as(FATMA, { csv, filename: "ekim.csv" }));
    await call("POST", "/api/v1/cards/imports", as(FATMA, { csv: "a;b" }));
    await call("POST", "/api/v1/cards/imports", as(FATMA, "{"));
    await call("POST", "/api/v1/cards/imports", as(FATMA, { csv: "x".repeat(9 * 1024 * 1024) }));
    await call("GET", "/api/v1/cards/imports", as(HAKAN));
    await call("GET", "/api/v1/cards/transactions", as(ALI), "/api/v1/cards/transactions?state=unmatched");
    await call("GET", "/api/v1/cards/transactions", as(HAKAN), "/api/v1/cards/transactions?holder=ali@example.com&from=2026-10-01&to=2026-10-31");
    await call("GET", "/api/v1/cards/transactions", as(ALI), "/api/v1/cards/transactions?state=lost");
  });

  it("reports, exports and what other products call", async () => {
    const range = "from=2026-10-01&to=2026-11-30";
    for (const by of ["category", "department", "project", "person", "month"])
      await call("GET", "/api/v1/reports/spend", as(HAKAN), `/api/v1/reports/spend?${range}&by=${by}&include=submitted`);
    await call("GET", "/api/v1/reports/spend", as(HAKAN), "/api/v1/reports/spend?by=colour");
    await call("GET", "/api/v1/reports/policy", as(HAKAN), `/api/v1/reports/policy?${range}`);
    await call("GET", "/api/v1/reports/policy", as(HAKAN), "/api/v1/reports/policy?from=x");
    await call("GET", "/api/v1/reports/kdv", as(HAKAN), `/api/v1/reports/kdv?${range}`);
    await call("GET", "/api/v1/reports/kdv", as(HAKAN), "/api/v1/reports/kdv?include=drafts");
    await call("GET", "/api/v1/exports/items", as(HAKAN), `/api/v1/exports/items?${range}`);
    await call("GET", "/api/v1/exports/items", as(HAKAN), "/api/v1/exports/items?to=2020-01-01");
    await call("GET", "/api/v1/exports/receipts", as(HAKAN), `/api/v1/exports/receipts?${range}`);
    await call("GET", "/api/v1/exports/receipts", as(HAKAN), "/api/v1/exports/receipts?from=2026-13-01");
    await call("GET", "/api/v1/exports/receipts", as(ALI), `/api/v1/exports/receipts?${range}`);
    await call("GET", "/api/v1/project-costs", as("admin"), `/api/v1/project-costs?${range}&project=acme`);
    await call("GET", "/api/v1/project-costs", as("admin"), "/api/v1/project-costs?from=2026-01-01&to=2030-01-01");
    await call("GET", "/api/v1/project-costs", anon());
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
