import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
// Money is kept as integers: an item's amount in its currency's minor units, and every TRY amount in kuruş, so sums
// never round. Rates are millionths of a lira for one unit of the currency.
const MIGRATIONS = [
  `-- People as HR (or the file) gives them: department and manager decide who approves. iban is what the person set here.
   CREATE TABLE people (
     email TEXT PRIMARY KEY,
     name TEXT,
     employee_id TEXT,
     department TEXT,
     department_name TEXT,
     manager_email TEXT,
     source TEXT NOT NULL CHECK (source IN ('hr', 'file')),
     active INTEGER NOT NULL DEFAULT 1,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE payees (email TEXT PRIMARY KEY, iban TEXT NOT NULL, updated_at TEXT NOT NULL);
   -- Projects as Time (or the file) gives them.
   CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('time', 'file')),
     active INTEGER NOT NULL DEFAULT 1,
     updated_at TEXT NOT NULL
   );
   -- A receipt's file, kept in this database so a backup of the one file has everything. sha256 is of the file as
   -- kept, without its metadata, and finds the same file sent twice. read_state is the reader's: none (no reader), pending, read, unclear or failed.
   CREATE TABLE receipts (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     owner_email TEXT NOT NULL,
     filename TEXT NOT NULL,
     content_type TEXT NOT NULL,
     size INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     data BLOB NOT NULL,
     read_state TEXT NOT NULL CHECK (read_state IN ('none', 'pending', 'read', 'unclear', 'failed')),
     read_fields TEXT,
     read_error TEXT,
     read_attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE INDEX receipts_sha ON receipts (sha256);
   CREATE INDEX receipts_reading ON receipts (read_state) WHERE read_state = 'pending';
   -- A claim: one person's expenses sent together. total is everything in kuruş; reimbursable what is paid back to
   -- them (less what a company card paid and what a cap held back).
   CREATE TABLE claims (
     id TEXT PRIMARY KEY,
     number TEXT NOT NULL UNIQUE,
     owner_id TEXT NOT NULL,
     owner_name TEXT NOT NULL,
     owner_email TEXT NOT NULL,
     department TEXT,
     title TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('draft', 'submitted', 'approved', 'rejected', 'paid')),
     round INTEGER NOT NULL DEFAULT 0,
     total INTEGER NOT NULL DEFAULT 0,
     reimbursable INTEGER NOT NULL DEFAULT 0,
     batch_id TEXT,
     submitted_at TEXT,
     decided_at TEXT,
     paid_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX claims_owner ON claims (owner_id, state);
   CREATE INDEX claims_state ON claims (state);
   -- An item: a receipt, a trip by car or days away. amount is in the currency's minor units; amount_try in kuruş, from
   -- the TCMB rate of rate_day, or what the card was charged. vat is a JSON list of { rate, amount } in kuruş.
   -- flags is a JSON list of what the policy found. held is the kuruş over a capped limit, not paid back.
   CREATE TABLE items (
     id TEXT PRIMARY KEY,
     claim_id TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('receipt', 'mileage', 'per_diem')),
     category TEXT NOT NULL,
     project TEXT,
     date TEXT NOT NULL,
     description TEXT,
     seller TEXT,
     seller_key TEXT,
     seller_tax_number TEXT,
     document TEXT NOT NULL CHECK (document IN ('invoice', 'receipt', 'other', 'none')),
     document_number TEXT,
     currency TEXT NOT NULL,
     amount INTEGER NOT NULL,
     rate_micro INTEGER,
     rate_day TEXT,
     rate_source TEXT NOT NULL CHECK (rate_source IN ('none', 'tcmb', 'card', 'pending')),
     amount_try INTEGER,
     vat TEXT NOT NULL DEFAULT '[]',
     km_tenths INTEGER,
     route TEXT,
     half_days INTEGER,
     country TEXT,
     receipt_id TEXT REFERENCES receipts (id),
     no_receipt_reason TEXT,
     paid_by TEXT NOT NULL CHECK (paid_by IN ('employee', 'company')),
     card_tx_id TEXT,
     read_used TEXT,
     flags TEXT NOT NULL DEFAULT '[]',
     held INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX items_claim ON items (claim_id, position);
   CREATE INDEX items_dupe ON items (seller_key, date, amount);
   CREATE INDEX items_date ON items (date);
   CREATE INDEX items_rate ON items (rate_source) WHERE rate_source = 'pending';
   -- The steps a claim goes through, per round (a claim sent back and sent again starts a new round). approver_email is
   -- null for a finance step, which any editor but the claimant and earlier approvers takes.
   CREATE TABLE steps (
     id TEXT PRIMARY KEY,
     claim_id TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
     round INTEGER NOT NULL,
     position INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('manager', 'finance', 'member')),
     approver_email TEXT,
     why TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('waiting', 'pending', 'approved', 'rejected', 'returned', 'cancelled')),
     by_id TEXT,
     by_name TEXT,
     at TEXT,
     comment TEXT
   );
   CREATE INDEX steps_claim ON steps (claim_id, round, position);
   CREATE INDEX steps_pending ON steps (state, approver_email) WHERE state = 'pending';
   -- What happened to a claim, for its history.
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     claim_id TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     by_id TEXT,
     by_name TEXT NOT NULL,
     action TEXT NOT NULL,
     text TEXT
   );
   CREATE INDEX events_claim ON events (claim_id, id);
   -- A payment of approved claims: with pay (Payroll takes it) or by bank transfer.
   CREATE TABLE batches (
     id TEXT PRIMARY KEY,
     number TEXT NOT NULL UNIQUE,
     method TEXT NOT NULL CHECK (method IN ('payroll', 'transfer')),
     state TEXT NOT NULL CHECK (state IN ('open', 'sent', 'paid')),
     pay_date TEXT NOT NULL,
     total INTEGER NOT NULL DEFAULT 0,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     sent_at TEXT,
     paid_at TEXT,
     paid_by TEXT
   );
   -- Company card statements as imported, and each purchase on them. hash keeps a line imported twice from being
   -- counted twice. item_id is the expense it was matched to.
   CREATE TABLE card_imports (
     id TEXT PRIMARY KEY,
     filename TEXT,
     by_name TEXT NOT NULL,
     at TEXT NOT NULL,
     added INTEGER NOT NULL,
     duplicates INTEGER NOT NULL,
     skipped INTEGER NOT NULL
   );
   CREATE TABLE card_transactions (
     id TEXT PRIMARY KEY,
     import_id TEXT NOT NULL REFERENCES card_imports (id),
     hash TEXT NOT NULL UNIQUE,
     card TEXT,
     holder_email TEXT,
     date TEXT NOT NULL,
     description TEXT NOT NULL,
     amount_try INTEGER NOT NULL,
     currency TEXT,
     amount INTEGER,
     item_id TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX card_tx_holder ON card_transactions (holder_email, date);
   CREATE INDEX card_tx_item ON card_transactions (item_id);
   -- TCMB's rates by the day they were announced, and the days it announced none (weekends and holidays).
   CREATE TABLE rates (
     day TEXT NOT NULL,
     currency TEXT NOT NULL,
     forex_buying INTEGER,
     forex_selling INTEGER,
     banknote_buying INTEGER,
     banknote_selling INTEGER,
     PRIMARY KEY (day, currency)
   );
   CREATE TABLE rate_days (day TEXT PRIMARY KEY, published INTEGER NOT NULL, fetched_at TEXT NOT NULL);
   CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
