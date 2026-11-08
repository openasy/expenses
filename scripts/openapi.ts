// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const day = { type: "string", format: "date", examples: ["2026-10-30"] };
const kurus = (description = "In kuruş.") => ({ type: "integer", description });
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const en = (...values: string[]) => ({ type: "string", enum: values });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const map = { type: "object" };

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const noContent = (description: string) => ({ description });
const file = (types: string[], description: string) => ({
  description,
  content: Object.fromEntries(types.map((t) => [t, { schema: { type: "string", format: "binary" } }])),
});
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [
  {
    name: "id",
    in: "path",
    required: true,
    description: `The ${what}'s id${what === "claim" ? " or number (EXP-2026-0001)" : what === "batch" ? " or number (PAY-2026-001)" : ""}.`,
    schema: str,
  },
];
const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", required: false, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });
const optJson = (schema: S) => ({ required: false, content: { "application/json": { schema } } });
const RANGE = [
  query("from", "The first day, YYYY-MM-DD; the first of this month when left out.", day),
  query("to", "The last day, YYYY-MM-DD; today when left out.", day),
];
const INCLUDE = query("include", "submitted also counts claims still waiting for approval; approved and paid ones count always.", en("submitted"));

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "user" | "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": role,
    description: [o.description, role === "user" ? "Any member (the user role is enough)." : `Needs the ${role} role.`].filter(Boolean).join("\n\n"),
    responses: { ...o.responses, "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const Flag = obj(
  {
    code: en("over-limit", "no-receipt", "duplicate", "same-file", "late", "receipt-differs"),
    text: str,
    finance: { type: "boolean", description: "Finance must approve the claim." },
    blocks: { type: "boolean", description: "The claim cannot be sent while it is there." },
    of: obj({ claim: str, item: str }),
  },
  ["code", "text", "finance", "blocks"],
);
const Vat = obj({ rate: { type: "number", description: "The KDV rate, from the file's kdv_rates." }, amount: kurus("The KDV at that rate, in kuruş.") });
const Named = obj({ id: str, name: str });

const Step = obj({
  id: str,
  position: int,
  kind: en("manager", "finance", "member"),
  approver: nul(obj({ email: str, name: nul(str), member: { type: "boolean", description: "Whether they are a member of Expenses and can approve." } })),
  why: str,
  state: en("waiting", "pending", "approved", "rejected", "returned", "cancelled"),
  by: nul(obj({ id: str, name: str })),
  at: nul(dt),
  comment: nul(str),
});

const claimProps = {
  id: str,
  number: { type: "string", examples: ["EXP-2026-0001"] },
  title: str,
  state: en("draft", "submitted", "approved", "rejected", "paid"),
  owner: obj({ id: str, name: str, email: str }),
  department: nul(Named),
  currency: { const: "TRY" },
  total: kurus("Everything on the claim, in kuruş."),
  reimbursable: kurus("What is paid back to the claimant: less what a company card paid and what a capped limit held back."),
  companyPaid: kurus("What a company card paid."),
  held: kurus("What is over a capped limit and not paid back."),
  items: int,
  flags: obj({ count: int, finance: int, blocking: int }),
  pending: nul(Step),
  batch: nul(obj({ id: str, number: str, method: en("payroll", "transfer"), state: en("open", "sent", "paid"), payDate: day })),
  submittedAt: nul(dt),
  decidedAt: nul(dt),
  paidAt: nul(dt),
  createdAt: dt,
  updatedAt: dt,
  canEdit: { type: "boolean", description: "A draft, and the caller's." },
  canDecide: { type: "boolean", description: "The caller may approve, reject or send back the waiting step." },
};

const batchProps = {
  id: str,
  number: { type: "string", examples: ["PAY-2026-001"] },
  method: en("payroll", "transfer"),
  state: en("open", "sent", "paid"),
  payDate: day,
  currency: { const: "TRY" },
  total: kurus(),
  people: int,
  claims: int,
  missingIban: { ...arr(str), description: "For a transfer: the people with no IBAN yet, by email." },
  createdBy: str,
  createdAt: dt,
  sentAt: nul(dt),
  paidAt: nul(dt),
  paidBy: nul(str),
};
const PersonLines = {
  amount: kurus(),
  claims: arr(obj({ id: str, number: str, title: str, amount: kurus() })),
  lines: arr(obj({ category: str, name: str, account: nul(str), project: nul(str), amount: kurus() })),
};

const ReadFields = obj({
  confidence: nul(num),
  amount: nul({ type: "integer", description: "In minor units of currency (TRY when null)." }),
  currency: nul(str),
  date: nul(day),
  seller: nul(str),
  sellerTaxNumber: nul(str),
  documentNumber: nul(str),
  vat: arr(Vat),
});

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        description: "Stable; match on this.",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "forbidden",
          "not-found",
          "conflict",
          "not-available",
          "link-failed",
          "rate-limited",
          "payload-too-large",
          "unsupported-media-type",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "cross-site",
        ],
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "expenses" }, version: str }),
  ProductList: obj({ products: arr(obj({ id: str, url: str })) }),
  Settings: obj({ file: nul(map), yaml: str, config: nul(map) }),
  Integrations: obj({ hr: map, time: map, reader: map, tcmb: map }),
  Me: obj({
    member: obj({ id: str, name: str, email: nul(str), role: str }),
    person: nul(obj({ employeeId: nul(str), department: nul(Named), manager: nul(str), source: en("hr", "file") })),
    iban: nul({ type: "string", description: "The caller's IBAN with only its first and last four characters." }),
  }),
  IbanInput: obj({ iban: nul({ type: "string", examples: ["TR33 0006 1005 1978 6457 8413 26"], description: "null removes it." }) }),
  Summary: obj({
    drafts: int,
    submitted: int,
    toApprove: int,
    owed: kurus("Approved and not paid yet, to the caller."),
    unmatchedCard: int,
    finance: nul(obj({ waiting: int, approvedUnpaid: int, approvedTotal: kurus(), openBatches: int, unmatchedCard: int, ratesPending: int })),
  }),
  Category: obj({
    id: str,
    name: str,
    kind: en("receipt", "mileage", "per_diem"),
    account: nul(str),
    kdv: nul(num),
    limits: obj({ perItem: nul(int), perDay: nul(int), perMonth: nul(int) }),
    overLimit: en("flag", "block", "cap"),
    project: en("required", "optional", "none"),
    perKm: nul(kurus("Mileage: kuruş per kilometre.")),
    perDay: nul({
      type: "object",
      description: "Daily allowance: a day's amount and currency by country, and default.",
      additionalProperties: obj({ amount: int, currency: str }),
    }),
  }),
  Policy: obj({
    currencies: arr(str),
    rates: obj({ source: { const: "tcmb" }, use: en("forex_buying", "forex_selling", "banknote_buying", "banknote_selling"), day: en("previous", "same") }),
    kdvRates: arr(num),
    receipts: obj({ maxSize: int, types: arr(str), maxAgeDays: nul(int), read: { type: "boolean", description: "Receipts are read by a reader." } }),
    categories: arr(ref("Category")),
  }),
  Projects: obj({ projects: arr(Named) }),
  People: obj({
    people: arr(obj({ email: str, name: nul(str), employeeId: nul(str), department: nul(Named), manager: nul(str), source: en("hr", "file"), member: bool })),
  }),
  RateQuote: obj({
    currency: str,
    date: day,
    use: str,
    day: { ...day, description: "The day TCMB announced the rate." },
    rate: { type: "string", examples: ["48.5000"], description: "TRY for one unit of the currency." },
    micro: { type: "integer", description: "Millionths of a lira for one unit." },
  }),
  Receipt: obj({
    id: str,
    filename: str,
    contentType: en("image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"),
    size: int,
    sha256: str,
    url: str,
    read: obj({ state: en("none", "pending", "read", "unclear", "failed"), fields: nul(ReadFields), error: nul(str) }),
    used: { ...arr(str), description: "The claims it is on, by number." },
    createdAt: dt,
  }),
  Flag,
  Step,
  Item: obj({
    id: str,
    kind: en("receipt", "mileage", "per_diem"),
    category: obj({ id: str, name: str, account: nul(str), inFile: bool }),
    project: nul(Named),
    date: day,
    description: nul(str),
    seller: nul(str),
    sellerTaxNumber: nul(str),
    document: en("invoice", "receipt", "other", "none"),
    documentNumber: nul(str),
    currency: str,
    amount: { type: "integer", description: "The receipt's total with KDV, in minor units of currency." },
    rate: obj({ source: en("none", "tcmb", "card", "pending"), value: nul(str), micro: nul(int), day: nul(day) }),
    amountTry: nul(kurus("In kuruş; null while the rate is pending.")),
    vat: arr(Vat),
    kdv: kurus(),
    net: nul(kurus("amountTry less the KDV.")),
    km: nul(num),
    route: nul(str),
    days: nul(num),
    country: nul(str),
    receipt: nul(obj({ id: str, filename: str, contentType: str, size: int, url: str })),
    noReceiptReason: nul(str),
    paidBy: en("employee", "company"),
    cardTransaction: nul(str),
    readUsed: { ...arr(str), description: "Fields taken from what the reader read." },
    flags: arr(ref("Flag")),
    held: kurus(),
    reimbursable: kurus(),
    createdAt: dt,
    updatedAt: dt,
  }),
  ItemInput: obj(
    {
      category: { type: "string", description: "A category id from the file; it decides the item's kind." },
      project: nul(str),
      date: day,
      description: nul(str),
      seller: nul(str),
      sellerTaxNumber: nul({ type: "string", description: "A VKN of 10 digits or a TCKN of 11." }),
      document: en("invoice", "receipt", "other", "none"),
      documentNumber: nul(str),
      currency: { type: "string", examples: ["TRY", "EUR"] },
      amount: { type: "integer", description: "The total with KDV, in minor units of currency: 64000 is 640.00." },
      vat: arr(obj({ rate: num, amount: int }, ["rate"])),
      km: { type: "number", description: "Mileage: kilometres, one decimal." },
      route: nul(str),
      days: { type: "number", description: "Daily allowance: days away, in half days." },
      country: { type: "string", description: "Daily allowance: a two-letter country code." },
      receipt: nul({ type: "string", description: "A receipt's id; its read fields fill what is left out." }),
      noReceiptReason: nul(str),
      cardTransaction: nul({ type: "string", description: "A company card purchase this item is; it is not paid back." }),
    },
    [],
  ),
  Claim: obj(claimProps),
  ClaimDetail: obj({
    ...claimProps,
    lines: arr(ref("Item")),
    steps: arr(ref("Step")),
    blocks: { ...arr(str), description: "What stops a draft from being sent." },
    history: arr(obj({ at: dt, by: obj({ id: nul(str), name: str }), action: str, text: nul(str) })),
  }),
  ClaimList: obj({ claims: arr(ref("Claim")) }),
  Batch: obj(batchProps),
  BatchDetail: obj({
    ...batchProps,
    lines: arr(obj({ person: obj({ email: str, name: str, employeeId: nul(str) }), iban: nul(str), ...PersonLines })),
  }),
  BatchList: obj({ batches: arr(ref("Batch")) }),
  CardImport: obj({
    check: bool,
    import: nul(str),
    added: int,
    duplicates: int,
    skipped: { type: "integer", description: "Payments to the card, refunds, totals and blank lines." },
    matched: int,
    withoutHolder: int,
    errors: arr(obj({ line: int, error: str })),
  }),
  CardImports: obj({ imports: arr(obj({ id: str, filename: nul(str), by: str, at: dt, added: int, duplicates: int, skipped: int })) }),
  CardTransactions: obj({
    transactions: arr(
      obj({
        id: str,
        card: nul(str),
        holder: nul(str),
        date: day,
        description: str,
        amountTry: kurus(),
        currency: nul(str),
        amount: nul(int),
        item: nul(obj({ id: str, claim: str, number: str })),
        importedAt: dt,
      }),
    ),
  }),
  Spend: obj({
    from: day,
    to: day,
    by: en("category", "department", "project", "person", "month"),
    currency: { const: "TRY" },
    total: kurus(),
    rows: arr(obj({ key: nul(str), name: str, total: kurus(), kdv: kurus(), net: kurus(), count: int, companyPaid: kurus(), reimbursable: kurus() })),
  }),
  PolicyReport: obj({
    from: day,
    to: day,
    items: arr(
      obj({
        claim: obj({ id: str, number: str, state: str, owner: obj({ name: str, email: str }) }),
        item: obj({ id: str, date: day, category: str, seller: nul(str), amountTry: nul(int), held: int }),
        flags: arr(ref("Flag")),
      }),
    ),
  }),
  KdvReport: obj({
    from: day,
    to: day,
    currency: { const: "TRY" },
    rates: arr(obj({ rate: num, base: kurus("The amount the KDV was charged on."), kdv: kurus(), count: int })),
    documents: arr(obj({ document: str, total: kurus(), kdv: kurus(), count: int })),
  }),
  Payroll: obj({
    month: { type: "string", examples: ["2026-11"] },
    currency: { const: "TRY" },
    batches: arr(
      obj({
        id: str,
        number: str,
        state: en("sent", "paid"),
        payDate: day,
        total: kurus(),
        people: arr(obj({ email: str, name: str, employeeId: nul(str), ...PersonLines })),
      }),
    ),
  }),
  ProjectCosts: obj({
    from: day,
    to: day,
    currency: { const: "TRY" },
    projects: arr(
      obj({ id: str, name: str, total: kurus(), kdv: kurus(), net: kurus(), count: int, categories: arr(obj({ id: str, name: str, amount: kurus() })) }),
    ),
  }),
};

const decision = (operationId: string, summary: string, description: string, needsComment: boolean) => ({
  post: op("user", {
    operationId,
    tags: ["Approvals"],
    summary,
    description,
    parameters: id("claim"),
    requestBody: optJson(obj({ comment: { type: "string", description: needsComment ? "Why; required." : "Optional." } }, needsComment ? ["comment"] : [])),
    responses: { "200": ok(ref("ClaimDetail")), "404": problem, "409": problem, "422": problem },
  }),
});

const paths: Record<string, S> = {
  "/api/v1/version": { get: pub({ operationId: "version", tags: ["Product"], summary: "Product and version", responses: { "200": ok(ref("Version")) } }) },
  "/api/v1/products": {
    get: op("user", { operationId: "products", tags: ["Product"], summary: "The install's other products", responses: { "200": ok(ref("ProductList")) } }),
  },
  "/api/v1/me": {
    get: op("user", { operationId: "me", tags: ["Product"], summary: "The caller, their department and manager", responses: { "200": ok(ref("Me")) } }),
  },
  "/api/v1/me/iban": {
    put: op("user", {
      operationId: "setIban",
      tags: ["Product"],
      summary: "Set the IBAN claims are paid back to by transfer",
      description: "Its check digits must add up. A signed-in person only; an API token has no IBAN.",
      requestBody: json(ref("IbanInput")),
      responses: { "200": ok(ref("Me")), "422": problem },
    }),
  },
  "/api/v1/summary": {
    get: op("user", {
      operationId: "summary",
      tags: ["Product"],
      summary: "The caller's drafts, claims to approve and what is owed; finance's counts for viewers and up",
      responses: { "200": ok(ref("Summary")) },
    }),
  },
  "/api/v1/policy": {
    get: op("user", {
      operationId: "policy",
      tags: ["Product"],
      summary: "Categories, limits, mileage and daily allowance rates, currencies and receipts, as the file sets them",
      responses: { "200": ok(ref("Policy")) },
    }),
  },
  "/api/v1/projects": {
    get: op("user", {
      operationId: "projects",
      tags: ["Product"],
      summary: "Projects expenses can be charged to, from Time or the file",
      responses: { "200": ok(ref("Projects")) },
    }),
  },
  "/api/v1/rates": {
    get: op("user", {
      operationId: "rate",
      tags: ["Product"],
      summary: "The TCMB rate a receipt in a currency on a day is converted at",
      parameters: [
        query("currency", "A currency other than TRY.", { type: "string", examples: ["EUR"] }),
        query("date", "The receipt's day; today when left out.", day),
      ],
      responses: { "200": ok(ref("RateQuote")), "422": problem, "502": problem },
    }),
  },
  "/api/v1/settings": {
    get: op("viewer", {
      operationId: "settings",
      tags: ["Product"],
      summary: "The settings file as applied, and its state",
      responses: { "200": ok(ref("Settings")) },
    }),
  },
  "/api/v1/integrations": {
    get: op("viewer", {
      operationId: "integrations",
      tags: ["Product"],
      summary: "HR, Time, the receipt reader and TCMB: configured, last success and error",
      responses: { "200": ok(ref("Integrations")) },
    }),
  },
  "/api/v1/people": {
    get: op("viewer", {
      operationId: "people",
      tags: ["Product"],
      summary: "People with their department and manager, from HR or the file",
      responses: { "200": ok(ref("People")) },
    }),
  },

  "/api/v1/receipts": {
    post: op("user", {
      operationId: "uploadReceipt",
      tags: ["Receipts"],
      summary: "Upload a receipt's photo or PDF",
      description:
        "The body is the file; its name goes in x-file-name (URL-encoded). It is taken only when its bytes are one of receipts.types and its size at most receipts.max_size; a PDF that carries scripts or launches files is refused. The same file sent again by the same person answers 200 with the receipt it made. With a reader in the file, it is read in the background: GET it to see the fields.",
      parameters: [{ name: "x-file-name", in: "header", required: false, schema: str }],
      requestBody: {
        required: true,
        content: Object.fromEntries(
          ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"].map((t) => [t, { schema: { type: "string", format: "binary" } }]),
        ),
      },
      responses: {
        "201": ok(ref("Receipt"), "Taken."),
        "200": ok(ref("Receipt"), "The same file, taken before."),
        "413": problem,
        "415": problem,
        "422": problem,
      },
    }),
  },
  "/api/v1/receipts/{id}": {
    get: op("user", {
      operationId: "getReceipt",
      tags: ["Receipts"],
      summary: "A receipt and what was read on it",
      description: "Its owner, the approvers of a claim it is on, and viewers see it.",
      parameters: id("receipt"),
      responses: { "200": ok(ref("Receipt")), "404": problem },
    }),
    delete: op("user", {
      operationId: "removeReceipt",
      tags: ["Receipts"],
      summary: "Remove a receipt that is on no item",
      parameters: id("receipt"),
      responses: { "204": noContent("Removed."), "404": problem, "409": problem },
    }),
  },
  "/api/v1/receipts/{id}/file": {
    get: op("user", {
      operationId: "receiptFile",
      tags: ["Receipts"],
      summary: "The receipt's file",
      description: "JPEG, PNG and WebP are shown inline; PDF and HEIC are downloaded. Always with a sandboxing content security policy and nosniff.",
      parameters: id("receipt"),
      responses: { "200": file(["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"], "The file."), "404": problem },
    }),
  },

  "/api/v1/claims": {
    get: op("user", {
      operationId: "listClaims",
      tags: ["Claims"],
      summary: "Claims: the caller's, those waiting for them, those they decided, or all",
      parameters: [
        query("scope", "mine (default), approvals, decided, or all (viewers and up).", en("mine", "approvals", "decided", "all")),
        query("state", "One or more states, comma separated."),
        query("department", "A department id."),
        query("person", "The claimant's email."),
        query("q", "Words in the title, number or name."),
      ],
      responses: { "200": ok(ref("ClaimList")), "422": problem },
    }),
    post: op("user", {
      operationId: "createClaim",
      tags: ["Claims"],
      summary: "Start a draft claim",
      description: "A claim is a signed-in person's; an API token cannot keep one.",
      requestBody: json(obj({ title: str })),
      responses: { "201": ok(ref("ClaimDetail")), "400": problem, "422": problem },
    }),
  },
  "/api/v1/claims/{id}": {
    get: op("user", {
      operationId: "getClaim",
      tags: ["Claims"],
      summary: "A claim with its items, steps and history",
      description: "Its claimant, its approvers and viewers see it; to anyone else it does not exist.",
      parameters: id("claim"),
      responses: { "200": ok(ref("ClaimDetail")), "404": problem },
    }),
    patch: op("user", {
      operationId: "updateClaim",
      tags: ["Claims"],
      summary: "Rename a draft",
      parameters: id("claim"),
      requestBody: json(obj({ title: str }, [])),
      responses: { "200": ok(ref("ClaimDetail")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("user", {
      operationId: "removeClaim",
      tags: ["Claims"],
      summary: "Delete a draft that was never sent",
      parameters: id("claim"),
      responses: { "204": noContent("Deleted."), "404": problem, "409": problem },
    }),
  },
  "/api/v1/claims/{id}/items": {
    post: op("user", {
      operationId: "addItem",
      tags: ["Claims"],
      summary: "Add a receipt, a trip by car or days away to a draft",
      description:
        "The category decides the kind. A receipt takes an amount in its currency's minor units; one in another currency is converted at TCMB's rate (rates in the file), and waits with its rate pending when TCMB cannot be reached. KDV is on TRY invoices and till receipts only: left out, it is the category's rate on the total. Mileage takes km, a daily allowance days and a country; their amounts follow from the file. A receipt id fills what the reader read and the request leaves out. A card purchase makes it the company's: not paid back, at what the card was charged.",
      parameters: id("claim"),
      requestBody: json(ref("ItemInput")),
      responses: { "201": ok(ref("Item")), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/items/{id}": {
    get: op("user", {
      operationId: "getItem",
      tags: ["Claims"],
      summary: "An item",
      parameters: id("item"),
      responses: { "200": ok(ref("Item")), "404": problem },
    }),
    patch: op("user", {
      operationId: "updateItem",
      tags: ["Claims"],
      summary: "Change an item of a draft",
      parameters: id("item"),
      requestBody: json(ref("ItemInput")),
      responses: { "200": ok(ref("Item")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("user", {
      operationId: "removeItem",
      tags: ["Claims"],
      summary: "Remove an item from a draft",
      parameters: id("item"),
      responses: { "204": noContent("Removed."), "404": problem, "409": problem },
    }),
  },
  "/api/v1/claims/{id}/submit": {
    post: op("user", {
      operationId: "submitClaim",
      tags: ["Approvals"],
      summary: "Send a draft for approval",
      description:
        "Refused (409) while an item breaks a blocking limit, has neither a receipt nor a reason, needs a project, or waits for its rate. The chain is the department's or the general one, by the total; finance is added for what the policy flags.",
      parameters: id("claim"),
      responses: { "200": ok(ref("ClaimDetail")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/claims/{id}/withdraw": {
    post: op("user", {
      operationId: "withdrawClaim",
      tags: ["Approvals"],
      summary: "Take a claim waiting for approval back to draft",
      parameters: id("claim"),
      responses: { "200": ok(ref("ClaimDetail")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/claims/{id}/approve": decision(
    "approveClaim",
    "Approve the waiting step",
    "By the member the step names, or for a finance step any editor who is not the claimant and did not approve an earlier step.",
    false,
  ),
  "/api/v1/claims/{id}/reject": decision("rejectClaim", "Reject the claim for good", "Who may approve the waiting step may reject it, saying why.", true),
  "/api/v1/claims/{id}/return": decision(
    "returnClaim",
    "Send the claim back to its claimant as a draft",
    "Who may approve the waiting step may send it back, saying what to change.",
    true,
  ),
  "/api/v1/claims/{id}/reassign": {
    post: op("editor", {
      operationId: "reassignStep",
      tags: ["Approvals"],
      summary: "Pass the waiting step to another member",
      description: "For a manager who is away or not a member. Never to the claimant or to someone who approved the claim already.",
      parameters: id("claim"),
      requestBody: json(obj({ to: { type: "string", description: "A member's email." }, comment: str }, ["to"])),
      responses: { "200": ok(ref("ClaimDetail")), "404": problem, "409": problem, "422": problem },
    }),
  },

  "/api/v1/batches": {
    get: op("viewer", {
      operationId: "listBatches",
      tags: ["Paying back"],
      summary: "Reimbursement batches",
      parameters: [query("state", "open, sent or paid.", en("open", "sent", "paid"))],
      responses: { "200": ok(ref("BatchList")), "422": problem },
    }),
    post: op("editor", {
      operationId: "createBatch",
      tags: ["Paying back"],
      summary: "Put approved claims in a batch, paid with pay or by transfer",
      description: "Without claims, every approved claim not in a batch with something to pay back.",
      requestBody: json(obj({ method: en("payroll", "transfer"), payDate: day, claims: arr(str) }, ["method"])),
      responses: { "201": ok(ref("BatchDetail")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/batches/{id}": {
    get: op("viewer", {
      operationId: "getBatch",
      tags: ["Paying back"],
      summary: "A batch, per person",
      parameters: id("batch"),
      responses: { "200": ok(ref("BatchDetail")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateBatch",
      tags: ["Paying back"],
      summary: "Change an open batch's pay date and claims",
      parameters: id("batch"),
      requestBody: json(obj({ payDate: day, add: arr(str), remove: arr(str) }, [])),
      responses: { "200": ok(ref("BatchDetail")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "removeBatch",
      tags: ["Paying back"],
      summary: "Remove an open batch; its claims wait again",
      parameters: id("batch"),
      responses: { "204": noContent("Removed."), "404": problem, "409": problem },
    }),
  },
  "/api/v1/batches/{id}/send": {
    post: op("editor", {
      operationId: "sendBatch",
      tags: ["Paying back"],
      summary: "Lock the batch: Payroll takes it, or the transfer list is made",
      description: "A transfer batch needs every person's IBAN.",
      parameters: id("batch"),
      responses: { "200": ok(ref("BatchDetail")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/batches/{id}/paid": {
    post: op("editor", {
      operationId: "batchPaid",
      tags: ["Paying back"],
      summary: "Mark a sent batch paid, and its claims",
      description: "Payroll calls it once the run is paid. The same again answers the batch as it is.",
      parameters: id("batch"),
      requestBody: optJson(obj({ paidOn: day }, [])),
      responses: { "200": ok(ref("BatchDetail")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/batches/{id}/transfers": {
    get: op("editor", {
      operationId: "batchTransfers",
      tags: ["Paying back"],
      summary: "The transfer list as CSV: name, IBAN, amount, currency, description",
      parameters: id("batch"),
      responses: {
        "200": { description: "CSV with a byte order mark, as exports in the file set it.", content: { "text/csv": { schema: str } } },
        "404": problem,
        "409": problem,
      },
    }),
  },

  "/api/v1/cards/imports": {
    post: op("editor", {
      operationId: "importCard",
      tags: ["Company cards"],
      summary: "Import a company card statement",
      description:
        "The bank's CSV, comma, semicolon or tab separated, with lines above the table allowed. Each purchase is kept once, given to its holder by the card's last four digits (cards.holders) or a holder column, and matched to the holder's draft receipt with the same amount within cards.match_days. check: true reads it and changes nothing.",
      requestBody: json(obj({ csv: str, filename: str, check: bool }, ["csv"])),
      responses: { "200": ok(ref("CardImport")), "400": problem, "413": problem, "422": problem },
    }),
    get: op("viewer", { operationId: "cardImports", tags: ["Company cards"], summary: "Statements imported", responses: { "200": ok(ref("CardImports")) } }),
  },
  "/api/v1/cards/transactions": {
    get: op("user", {
      operationId: "cardTransactions",
      tags: ["Company cards"],
      summary: "Card purchases: the caller's own, or everyone's for viewers and up",
      parameters: [
        query("state", "unmatched, matched or all (default).", en("unmatched", "matched", "all")),
        query("holder", "Viewers and up: the holder's email."),
        ...RANGE,
      ],
      responses: { "200": ok(ref("CardTransactions")), "422": problem },
    }),
  },

  "/api/v1/reports/spend": {
    get: op("viewer", {
      operationId: "spend",
      tags: ["Reports"],
      summary: "Spending by category, department, project, person or month",
      parameters: [
        query("by", "category (default), department, project, person or month.", en("category", "department", "project", "person", "month")),
        ...RANGE,
        INCLUDE,
      ],
      responses: { "200": ok(ref("Spend")), "422": problem },
    }),
  },
  "/api/v1/reports/policy": {
    get: op("viewer", {
      operationId: "policyReport",
      tags: ["Reports"],
      summary: "Items in sent claims that the policy flagged",
      parameters: RANGE,
      responses: { "200": ok(ref("PolicyReport")), "422": problem },
    }),
  },
  "/api/v1/reports/kdv": {
    get: op("viewer", {
      operationId: "kdvReport",
      tags: ["Reports"],
      summary: "KDV by rate and document",
      parameters: [...RANGE, INCLUDE],
      responses: { "200": ok(ref("KdvReport")), "422": problem },
    }),
  },
  "/api/v1/exports/items": {
    get: op("viewer", {
      operationId: "exportItems",
      tags: ["Reports"],
      summary: "Every item as CSV for the accountant",
      description:
        "With the account code, KDV per rate, the TCMB rate and its day, and the receipt's name in the receipts export. Separator and decimal as exports in the file sets them.",
      parameters: [...RANGE, INCLUDE],
      responses: { "200": { description: "CSV with a byte order mark.", content: { "text/csv": { schema: str } } }, "422": problem },
    }),
  },
  "/api/v1/exports/receipts": {
    get: op("viewer", {
      operationId: "exportReceipts",
      tags: ["Reports"],
      summary: "The period's receipts as a ZIP, by claim",
      parameters: [...RANGE, INCLUDE],
      responses: { "200": file(["application/zip"], "A ZIP; names as the items export gives them."), "422": problem },
    }),
  },

  "/api/v1/payroll": {
    get: op("viewer", {
      operationId: "payroll",
      tags: ["Contracts"],
      summary: "For Payroll: the month's payroll batches, per person",
      description:
        "Batches paid with pay, sent or paid, whose pay date is in the month, with each person's employee id, amount and lines by category and project. Payroll marks a batch paid with POST /api/v1/batches/{id}/paid.",
      parameters: [query("month", "YYYY-MM; this month when left out.", { type: "string", examples: ["2026-11"] })],
      responses: { "200": ok(ref("Payroll")), "422": problem },
    }),
  },
  "/api/v1/project-costs": {
    get: op("viewer", {
      operationId: "projectCosts",
      tags: ["Contracts"],
      summary: "For Time: approved and paid spending charged to each project",
      parameters: [...RANGE, query("project", "One project's id.")],
      responses: { "200": ok(ref("ProjectCosts")), "422": problem },
    }),
  },

  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy Expenses",
    version,
    description:
      "Receipts, claims and approvals by the rules expenses.yaml sets, with TCMB rates, KDV, company card statements, reimbursement batches and exports for the accountant. Amounts are whole numbers: a currency's minor units, and kuruş for TRY. Every member sends their own claims and approves what names them; viewers read everything; editors are finance; admins also manage members and tokens.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
