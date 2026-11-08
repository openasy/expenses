// Starts the app on a random port for tests, with fakes of TCMB, HR, Time and a receipt reader, and a token for each
// member so a test calls the API as that person.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { encode as encodeJpeg } from "jpeg-js";
import { createApp, type AppOptions } from "./app.ts";
import { createCards } from "./cards.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createExpenses } from "./expenses.ts";
import { HR_TOKEN, READER_TOKEN, startFakes, TIME_TOKEN } from "./fakes.ts";
import { createReports } from "./reports.ts";
import type { Actor } from "./store.ts";

export const ADMIN_TOKEN = "test-admin-token";

/**
 * Members of the test install. Ali and Deniz spend; Emily is Ali's manager; Hakan heads sales and reads everything;
 * Fatma and Selin are finance, Selin also an admin. Deniz's manager, can@example.com, is not a member.
 */
export const ALI: Actor = { id: "user-ali", name: "Ali Demir", role: "user", email: "ali@example.com" };
export const EMILY: Actor = { id: "user-emily", name: "Emily Clark", role: "user", email: "emily@example.com" };
export const HAKAN: Actor = { id: "user-hakan", name: "Hakan Yıldız", role: "viewer", email: "hakan@example.com" };
export const FATMA: Actor = { id: "user-fatma", name: "Fatma Şen", role: "editor", email: "fatma@example.com" };
export const SELIN: Actor = { id: "user-selin", name: "Selin Aydın", role: "admin", email: "selin@example.com" };
export const DENIZ: Actor = { id: "user-deniz", name: "Deniz Kaya", role: "user", email: "deniz@example.com" };
export const MEMBERS = [ALI, EMILY, HAKAN, FATMA, SELIN, DENIZ];
export const tokenOf = (a: Actor) => `test-token-${a.id}`;

/** The settings file the tests start with; FAKES is replaced with the fakes' address. */
export const SETTINGS = `
time_zone: Europe/Istanbul
currencies: [EUR, USD, GBP, JPY]
rates: { url: FAKES/tcmb }
receipts:
  max_size: 1MB
  max_age: 90d
  reader: { url: FAKES/reader, token: READER_TOKEN, min_confidence: 0.8 }
categories:
  travel: { name: Travel, account: "770.01", kdv: 20% }
  meals: { name: Meals, account: "770.02", kdv: 10%, limit: { per_day: 750 } }
  hotel: { name: Hotel, account: "770.03", kdv: 10%, limit: { per_item: 5000 }, over_limit: cap }
  gifts: { name: Gifts, account: "770.09", kdv: 20%, limit: { per_item: 1000 }, over_limit: block }
  software: { name: Software, account: "770.05", kdv: 20%, project: required }
  mileage: { name: Mileage, kind: mileage, rate: 8.50, account: "770.04" }
  per-diem: { name: Daily allowance, kind: per_diem, rates: { TR: 600, DE: 60 EUR, default: 50 EUR }, account: "770.06" }
approvals:
  chain:
    - manager
    - { approver: finance, over: 10000 }
    - { approver: hakan@example.com, over: 50000 }
  departments:
    engineering:
      - manager
      - { approver: selin@example.com, over: 20000 }
departments:
  sales: Sales
  engineering: { name: Engineering }
people:
  ali@example.com: { name: Ali Demir, department: sales, manager: emily@example.com, employee_id: "1042" }
  emily@example.com: { department: sales, manager: hakan@example.com, employee_id: "1007" }
  hakan@example.com: { department: sales }
  deniz@example.com: { department: engineering, manager: can@example.com, employee_id: "1100" }
projects:
  acme: Acme rollout
  internal: { name: Internal }
cards:
  holders: { "4417": ali@example.com, "9001": deniz@example.com }
  match_days: 3
`;

/** The settings with HR and Time linked instead of the file's people and projects. */
export const LINKED = SETTINGS.replace("categories:", "hr: { url: FAKES/hr, token: HR_TOKEN }\ntime: { url: FAKES/time, token: TIME_TOKEN }\ncategories:");

/** A clock the test moves by hand: Monday 2 November 2026, 09:00 in Istanbul. */
export function fakeClock(start = Date.parse("2026-11-02T06:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

/** TCMB's files around the test's today: 29 October is Republic Day, with no file; 2 November's comes at 15:30. */
export const RATE_DAYS = {
  "2026-10-27": { USD: { forexBuying: "42.0000" }, EUR: { forexBuying: "48.0000" } },
  "2026-10-28": {
    USD: { forexBuying: "42.1234", forexSelling: "42.2000", banknoteBuying: "42.1000", banknoteSelling: "42.3000" },
    EUR: { forexBuying: "48.5000", forexSelling: "48.6000" },
    GBP: { forexBuying: "55.0000" },
    JPY: { unit: 100, forexBuying: "27.8000" },
  },
  "2026-10-30": {
    USD: { forexBuying: "42.3000" },
    EUR: { forexBuying: "48.7000" },
    GBP: { forexBuying: "55.2000" },
    JPY: { unit: 100, forexBuying: "27.9000" },
  },
} as const;

export async function startApp(opts: Partial<AppOptions> & { version?: string; settings?: string } = {}) {
  const fakes = await startFakes();
  fakes.state.tcmb.days = structuredClone(RATE_DAYS) as unknown as typeof fakes.state.tcmb.days;
  fakes.state.reader.answer = { confidence: 0.95, amount: "640.00", currency: "TRY", date: "2026-10-30", seller: "Kuzu Lokantası" };
  const db = openDb(":memory:");
  const { settings = SETTINGS, version = "0.1.0", ...rest } = opts;
  const clock = fakeClock();
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "expenses", productName: "OpenAsy Expenses", origin: base, users: true });
  for (const m of MEMBERS)
    db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(
      m.id,
      m.email,
      m.name,
      m.role,
      new Date().toISOString(),
    );
  const env = { READER_TOKEN, HR_TOKEN, TIME_TOKEN };
  const x = createExpenses(db, { publicUrl: base, env, clock });
  const text = settings.replaceAll("FAKES", fakes.base);
  x.setConfig(parseConfig(text), text);
  const cards = createCards(x);
  const reports = createReports(x);
  const testTokens = Object.fromEntries(MEMBERS.map((m) => [tokenOf(m), m]));
  handler = createApp({ db, expenses: x, cards, reports, auth, adminToken: ADMIN_TOKEN, testTokens, version, ...rest });

  /** Calls the API as a member (or the admin token), with a JSON body. */
  const as = (who: Actor | "admin" | null) => async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who) headers.authorization = `Bearer ${who === "admin" ? ADMIN_TOKEN : tokenOf(who)}`;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await res.json() : type.startsWith("text/") ? await res.text() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: data as any, headers: res.headers };
  };
  /** Uploads a receipt's bytes as a member. */
  const upload = async (who: Actor, data: Buffer, type = "image/jpeg", name = "receipt.jpg") => {
    const res = await fetch(`${base}/api/v1/receipts`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenOf(who)}`, "content-type": type, "x-file-name": encodeURIComponent(name) },
      body: new Uint8Array(data),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fakes.close();
  };
  return { db, x, cards, reports, auth, base, as, upload, clock, fakes, close };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

/** A real 16x16 JPEG, different for each seed. */
export function jpeg(seed = 0): Buffer {
  const data = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([(seed * 37 + i) % 256, (seed * 11) % 256, (i / 4) % 256, 255], i);
  return Buffer.from(encodeJpeg({ data, width: 16, height: 16 }, 90).data);
}

export const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
