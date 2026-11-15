// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json. Every amount is a whole
// number of its currency's minor units (kuruş for TRY), as the API gives it; the pages never add up money themselves.

export interface ProductLink {
  id: string;
  url: string;
}

export type ClaimState = "draft" | "submitted" | "approved" | "rejected" | "paid";
export type ItemKind = "receipt" | "mileage" | "per_diem";
export type StepState = "waiting" | "pending" | "approved" | "rejected" | "returned" | "cancelled";
export type FlagCode = "over-limit" | "no-receipt" | "duplicate" | "same-file" | "late" | "receipt-differs";
export type BatchMethod = "payroll" | "transfer";
export type BatchState = "open" | "sent" | "paid";
export type DocumentKind = "invoice" | "receipt" | "other" | "none";
export type ReadState = "none" | "pending" | "read" | "unclear" | "failed";

export interface Ref {
  id: string;
  name: string;
}

export interface Me {
  member: { id: string; name: string; email: string | null; role: string };
  person: { employeeId: string | null; department: Ref | null; manager: string | null; source: "hr" | "file" } | null;
  /** Masked: TR33 **** 8413. */
  iban: string | null;
}

export interface Summary {
  drafts: number;
  submitted: number;
  toApprove: number;
  owed: number;
  unmatchedCard: number;
  finance: {
    waiting: number;
    approvedUnpaid: number;
    approvedTotal: number;
    openBatches: number;
    unmatchedCard: number;
    ratesPending: number;
  } | null;
}

export interface Category {
  id: string;
  name: string;
  kind: ItemKind;
  account: string | null;
  kdv: number | null;
  limits: { perItem: number | null; perDay: number | null; perMonth: number | null };
  overLimit: "flag" | "block" | "cap";
  project: "required" | "optional" | "none";
  /** Mileage: kuruş per kilometre. */
  perKm: number | null;
  /** Daily allowance by country code, with "default" for the rest. */
  perDay: Record<string, { amount: number; currency: string }> | null;
}

export interface Policy {
  currencies: string[];
  rates: { source: string; use: "forex_buying" | "forex_selling" | "banknote_buying" | "banknote_selling"; day: "previous" | "same" };
  kdvRates: number[];
  receipts: { maxSize: number; types: string[]; maxAgeDays: number | null; read: boolean };
  categories: Category[];
}

export interface ReadFields {
  confidence: number | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  seller: string | null;
  sellerTaxNumber: string | null;
  documentNumber: string | null;
  vat: Array<{ rate: number; amount: number }>;
}

export interface Receipt {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  url: string;
  read: { state: ReadState; fields: ReadFields | null; error: string | null };
  used: string[];
  createdAt: string;
}

export interface Flag {
  code: FlagCode;
  text: string;
  finance: boolean;
  blocks: boolean;
  of?: { claim: string; item: string };
}

export interface Step {
  id: string;
  position: number;
  kind: "manager" | "finance" | "member";
  approver: { email: string; name: string | null; member: boolean } | null;
  why: string;
  state: StepState;
  by: Ref | null;
  at: string | null;
  comment: string | null;
}

export interface Item {
  id: string;
  kind: ItemKind;
  category: { id: string; name: string; account: string | null; inFile: boolean };
  project: Ref | null;
  date: string;
  description: string | null;
  seller: string | null;
  sellerTaxNumber: string | null;
  document: DocumentKind;
  documentNumber: string | null;
  currency: string;
  amount: number;
  rate: { source: "none" | "tcmb" | "card" | "pending"; value: string | null; micro: number | null; day: string | null };
  amountTry: number | null;
  vat: Array<{ rate: number; amount: number }>;
  kdv: number;
  net: number | null;
  km: number | null;
  route: string | null;
  days: number | null;
  country: string | null;
  receipt: { id: string; filename: string; contentType: string; size: number; url: string } | null;
  noReceiptReason: string | null;
  paidBy: "employee" | "company";
  cardTransaction: string | null;
  readUsed: string[];
  flags: Flag[];
  held: number;
  reimbursable: number;
  createdAt: string;
  updatedAt: string;
}

export interface ItemInput {
  category?: string;
  project?: string | null;
  date?: string;
  description?: string | null;
  seller?: string | null;
  sellerTaxNumber?: string | null;
  document?: DocumentKind;
  documentNumber?: string | null;
  currency?: string;
  amount?: number;
  vat?: Array<{ rate: number; amount?: number }>;
  km?: number;
  route?: string | null;
  days?: number;
  country?: string;
  receipt?: string | null;
  noReceiptReason?: string | null;
  cardTransaction?: string | null;
}

export interface BatchRef {
  id: string;
  number: string;
  method: BatchMethod;
  state: BatchState;
  payDate: string;
}

export interface Claim {
  id: string;
  number: string;
  title: string;
  state: ClaimState;
  owner: { id: string; name: string; email: string };
  department: Ref | null;
  currency: string;
  total: number;
  reimbursable: number;
  companyPaid: number;
  held: number;
  items: number;
  flags: { count: number; finance: number; blocking: number };
  pending: Step | null;
  batch: BatchRef | null;
  submittedAt: string | null;
  decidedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDecide: boolean;
}

export interface ClaimDetail extends Claim {
  lines: Item[];
  steps: Step[];
  /** A draft: who would approve it if it were sent now. */
  plan: Array<{ kind: Step["kind"]; approver: Step["approver"]; why: string }>;
  /** Why the claim cannot be sent yet. */
  blocks: string[];
  history: Array<{ at: string; by: { id: string | null; name: string }; action: string; text: string | null }>;
}

export interface Batch {
  id: string;
  number: string;
  method: BatchMethod;
  state: BatchState;
  payDate: string;
  currency: string;
  total: number;
  people: number;
  claims: number;
  missingIban: string[];
  createdBy: string;
  createdAt: string;
  sentAt: string | null;
  paidAt: string | null;
  paidBy: string | null;
}

export interface BatchDetail extends Batch {
  lines: Array<{
    person: { email: string; name: string; employeeId: string | null };
    iban: string | null;
    amount: number;
    claims: Array<{ id: string; number: string; title: string; amount: number }>;
  }>;
}

export interface CardImport {
  check: boolean;
  import: string | null;
  added: number;
  duplicates: number;
  skipped: number;
  matched: number;
  withoutHolder: number;
  errors: Array<{ line: number; error: string }>;
}

export interface CardTransaction {
  id: string;
  card: string | null;
  holder: string | null;
  date: string;
  description: string;
  amountTry: number;
  currency: string | null;
  amount: number | null;
  item: { id: string; claim: string; number: string } | null;
  importedAt: string;
}

export type SpendBy = "category" | "department" | "project" | "person" | "month";

export interface Spend {
  from: string;
  to: string;
  by: SpendBy;
  currency: string;
  total: number;
  rows: Array<{ key: string | null; name: string; total: number; kdv: number; net: number; count: number; companyPaid: number; reimbursable: number }>;
}

export interface PolicyReport {
  from: string;
  to: string;
  items: Array<{
    claim: { id: string; number: string; state: string; owner: { name: string; email: string } };
    item: { id: string; date: string; category: string; seller: string | null; amountTry: number | null; held: number };
    flags: Flag[];
  }>;
}

export interface KdvReport {
  from: string;
  to: string;
  currency: string;
  rates: Array<{ rate: number; base: number; kdv: number; count: number }>;
  documents: Array<{ document: string; total: number; kdv: number; count: number }>;
}

export interface LinkState {
  configured: boolean;
  okAt: string | null;
  errorAt: string | null;
  error: string | null;
  url: string | null;
}

export interface Integrations {
  hr: LinkState & { people: number };
  time: LinkState & { projects: number };
  reader: LinkState & { waiting: number };
  tcmb: LinkState & { lastDay: string | null; pending: number };
}

export interface Settings {
  file: { path: string; appliedAt: string | null; error: string | null; warnings: string[] } | null;
  yaml: string;
  config: {
    timeZone: string;
    currencies: string[] | null;
    rates: { url: string; kind: string; day: string };
    receipts: { maxSize: number; types: string[]; maxAgeDays: number | null; reader: { url: string; minConfidence: number } | null };
    kdvRates: number[];
    categories: Category[];
    approvals: { chain: Array<{ approver: string; over: number }>; departments: Record<string, Array<{ approver: string; over: number }>> };
    departments: Ref[];
    cards: { holders: Record<string, string>; matchDays: number; purchases: string };
    exports: { separator: string; decimal: string };
    hr: { url: string; token: string; everyMinutes: number } | null;
    time: { url: string; token: string; everyMinutes: number } | null;
  } | null;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
