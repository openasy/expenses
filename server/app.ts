import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { atLeast, AuthError, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Cards } from "./cards.ts";
import { csvText } from "./csv.ts";
import type { Expenses } from "./expenses.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import type { Reports } from "./reports.ts";
import { INLINE } from "./sniff.ts";
import { ExpensesError, type Actor, type ProblemCode } from "./store.ts";

export interface AppOptions {
  db: DatabaseSync;
  expenses: Expenses;
  cards: Cards;
  reports: Reports;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** For tests only: bearer tokens that act as these members, with their email. main.ts never sets it. */
  testTokens?: Record<string, Actor>;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(x: Expenses, version: string) {
  return renderMetrics(version, { ...x.gauges(), fileError: !!x.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (EXPENSES_METRICS_PORT). */
export function createMetricsHandler(x: Expenses, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(x, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** The pages run nothing from elsewhere. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-available": "Not available",
  "link-failed": "Another service failed",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "unsupported-media-type": "Unsupported media type",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  const tooLarge = () => new ExpensesError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  // A body too large is read to its end and dropped, so the answer reaches a client still sending and the
  // connection stays usable; past four times the limit the connection is cut.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4 * limit) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw tooLarge();
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = (await readBody(req, limit)).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ExpensesError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const download = (filename: string) => ({ "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" });

/** The role a route needs (ADR 0003); "none" for the version, which anyone may call. "user" is every member. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
  raw: () => Promise<Buffer>;
}
interface Route {
  method: string;
  path: string;
  auth: Access;
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  expenses: x,
  cards,
  reports,
  version,
  auth,
  adminToken,
  testTokens = {},
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const created = (res: ServerResponse, data: unknown) => json(res, 201, data);
  const P = "/api/v1";

  const routes: Route[] = [
    { method: "GET", path: `${P}/version`, auth: "none", handle: () => ({ product: "expenses", version }) },
    { method: "GET", path: `${P}/products`, auth: "user", handle: () => ({ products }) },
    { method: "GET", path: `${P}/me`, auth: "user", handle: ({ who }) => x.me(who) },
    { method: "PUT", path: `${P}/me/iban`, auth: "user", handle: async ({ who, body }) => x.setIban(who, await body()) },
    { method: "GET", path: `${P}/summary`, auth: "user", handle: ({ who }) => x.summary(who) },
    { method: "GET", path: `${P}/policy`, auth: "user", handle: () => x.policy() },
    { method: "GET", path: `${P}/projects`, auth: "user", handle: () => ({ projects: x.projects() }) },
    { method: "GET", path: `${P}/rates`, auth: "user", handle: ({ url }) => x.rateQuote(url.searchParams) },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: `${P}/settings`, auth: "viewer", handle: () => x.settings() },
    { method: "GET", path: `${P}/integrations`, auth: "viewer", handle: () => x.integrations() },
    { method: "GET", path: `${P}/people`, auth: "viewer", handle: () => ({ people: x.people() }) },

    // Receipts: the file is the body, its name in x-file-name.
    {
      method: "POST",
      path: `${P}/receipts`,
      auth: "user",
      limit: 26 * 1024 * 1024,
      handle: async ({ req, res, who, raw }) => {
        const name = (() => {
          try {
            return decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
          } catch {
            return "";
          }
        })();
        const r = x.addReceipt(who, String(req.headers["content-type"] ?? ""), name, await raw());
        json(res, r.created ? 201 : 200, r.receipt);
      },
    },
    { method: "GET", path: `${P}/receipts/:id`, auth: "user", handle: ({ who, params }) => x.getReceipt(who, params[0]!) },
    {
      method: "GET",
      path: `${P}/receipts/:id/file`,
      auth: "user",
      handle: ({ res, who, params }) => {
        const f = x.receiptFile(who, params[0]!);
        // Only plain image types are shown in the page; PDFs and HEIC are downloaded, and nothing in them can run here.
        const inline = INLINE.has(f.contentType);
        send(res, 200, f.data, f.contentType, {
          "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "private, no-store",
          "cross-origin-resource-policy": "same-origin",
        });
      },
    },
    { method: "DELETE", path: `${P}/receipts/:id`, auth: "user", handle: ({ res, who, params }) => (x.removeReceipt(who, params[0]!), noContent(res)) },

    // Claims and their items.
    { method: "GET", path: `${P}/claims`, auth: "user", handle: ({ who, url }) => ({ claims: x.listClaims(who, url.searchParams) }) },
    { method: "POST", path: `${P}/claims`, auth: "user", handle: async ({ res, who, body }) => created(res, x.createClaim(who, await body())) },
    { method: "GET", path: `${P}/claims/:id`, auth: "user", handle: ({ who, params }) => x.getClaim(who, params[0]!) },
    { method: "PATCH", path: `${P}/claims/:id`, auth: "user", handle: async ({ who, params, body }) => x.updateClaim(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/claims/:id`, auth: "user", handle: ({ res, who, params }) => (x.removeClaim(who, params[0]!), noContent(res)) },
    {
      method: "POST",
      path: `${P}/claims/:id/items`,
      auth: "user",
      handle: async ({ res, who, params, body }) => created(res, await x.addItem(who, params[0]!, await body())),
    },
    { method: "GET", path: `${P}/items/:id`, auth: "user", handle: ({ who, params }) => x.getItem(who, params[0]!) },
    { method: "PATCH", path: `${P}/items/:id`, auth: "user", handle: async ({ who, params, body }) => x.updateItem(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/items/:id`, auth: "user", handle: ({ res, who, params }) => (x.removeItem(who, params[0]!), noContent(res)) },
    { method: "POST", path: `${P}/claims/:id/submit`, auth: "user", handle: ({ who, params }) => x.submit(who, params[0]!) },
    { method: "POST", path: `${P}/claims/:id/withdraw`, auth: "user", handle: ({ who, params }) => x.withdraw(who, params[0]!) },
    {
      method: "POST",
      path: `${P}/claims/:id/approve`,
      auth: "user",
      handle: async ({ who, params, body }) => x.decide(who, params[0]!, await body(), "approve"),
    },
    {
      method: "POST",
      path: `${P}/claims/:id/reject`,
      auth: "user",
      handle: async ({ who, params, body }) => x.decide(who, params[0]!, await body(), "reject"),
    },
    {
      method: "POST",
      path: `${P}/claims/:id/return`,
      auth: "user",
      handle: async ({ who, params, body }) => x.decide(who, params[0]!, await body(), "return"),
    },
    { method: "POST", path: `${P}/claims/:id/reassign`, auth: "editor", handle: async ({ who, params, body }) => x.reassign(who, params[0]!, await body()) },

    // Paying back.
    { method: "GET", path: `${P}/batches`, auth: "viewer", handle: ({ url }) => ({ batches: x.listBatches(url.searchParams) }) },
    { method: "POST", path: `${P}/batches`, auth: "editor", handle: async ({ res, who, body }) => created(res, x.createBatch(who, await body())) },
    { method: "GET", path: `${P}/batches/:id`, auth: "viewer", handle: ({ params }) => x.getBatch(params[0]!) },
    { method: "PATCH", path: `${P}/batches/:id`, auth: "editor", handle: async ({ who, params, body }) => x.updateBatch(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/batches/:id`, auth: "editor", handle: ({ res, who, params }) => (x.removeBatch(who, params[0]!), noContent(res)) },
    { method: "POST", path: `${P}/batches/:id/send`, auth: "editor", handle: ({ who, params }) => x.sendBatch(who, params[0]!) },
    { method: "POST", path: `${P}/batches/:id/paid`, auth: "editor", handle: async ({ who, params, body }) => x.paidBatch(who, params[0]!, await body()) },
    {
      method: "GET",
      path: `${P}/batches/:id/transfers`,
      auth: "editor",
      handle: ({ res, who, params }) => {
        const t = x.transfers(who, params[0]!);
        send(res, 200, csvText(t.rows, x.cfg().exports.separator), "text/csv; charset=utf-8", download(t.filename));
      },
    },

    // Company cards.
    { method: "POST", path: `${P}/cards/imports`, auth: "editor", limit: 8 * 1024 * 1024, handle: async ({ who, body }) => cards.importCsv(who, await body()) },
    { method: "GET", path: `${P}/cards/imports`, auth: "viewer", handle: () => ({ imports: cards.listImports() }) },
    {
      method: "GET",
      path: `${P}/cards/transactions`,
      auth: "user",
      handle: ({ who, url }) => ({ transactions: cards.listTransactions(who, url.searchParams) }),
    },

    // Reports and exports.
    { method: "GET", path: `${P}/reports/spend`, auth: "viewer", handle: ({ url }) => reports.spend(url.searchParams) },
    { method: "GET", path: `${P}/reports/policy`, auth: "viewer", handle: ({ url }) => reports.policyReport(url.searchParams) },
    { method: "GET", path: `${P}/reports/kdv`, auth: "viewer", handle: ({ url }) => reports.kdvReport(url.searchParams) },
    {
      method: "GET",
      path: `${P}/exports/items`,
      auth: "viewer",
      handle: ({ res, who, url }) => {
        const e = reports.exportItems(who, url.searchParams);
        send(res, 200, e.text, "text/csv; charset=utf-8", download(e.filename));
      },
    },
    {
      method: "GET",
      path: `${P}/exports/receipts`,
      auth: "viewer",
      handle: ({ res, url }) => {
        const e = reports.exportReceipts(url.searchParams);
        send(res, 200, e.zip, "application/zip", download(e.filename));
      },
    },

    // What other products call: Payroll takes the payroll batches; Time shows what was spent on a project.
    { method: "GET", path: `${P}/payroll`, auth: "viewer", handle: ({ url }) => x.payroll(url.searchParams) },
    { method: "GET", path: `${P}/project-costs`, auth: "viewer", handle: ({ url }) => reports.projectCosts(url.searchParams) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous", role: "viewer", email: null };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token", role: "admin", email: null };
    for (const [token, actor] of Object.entries(testTokens)) {
      if (!tokenMatches(req.headers.authorization, token)) continue;
      if (!atLeast(actor.role, access)) throw new ExpensesError(403, "forbidden", `This needs the ${access} role or higher.`);
      return actor;
    }
    const p = auth.authorize(req, access);
    return p.kind === "session"
      ? { id: p.user.id, name: p.user.name, role: p.role, email: p.user.email.toLowerCase() }
      : { id: `token:${p.tokenId}`, name: p.name, role: p.role, email: null };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!x.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }
    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(x, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, path.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const limit = r.limit ?? 1024 * 1024;
        const result = await r.handle({
          req,
          res,
          url,
          params,
          who,
          body: () => readJson(req, limit),
          raw: () => readBody(req, limit),
        });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof ExpensesError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");
    // No screens yet: the API is the product until they are designed.
    if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
      send(res, 200, `OpenAsy Expenses ${version}. The API is at /api/v1; its reference at /api/docs/.\n`, "text/plain; charset=utf-8");
      return "/";
    }
    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Queries can carry a person's email; only the path is logged.
    if (!["/healthz", "/metrics"].includes(routeName)) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
