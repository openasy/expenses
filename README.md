# expenses

[![CI](https://github.com/openasy/expenses/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/expenses/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Expenses product: receipts photographed and read, claims with a category
and a project for each expense, mileage and daily allowances, limits per category set in a file, approval chains by
amount and department, receipts in other currencies at TCMB's rate, KDV per rate, company card statements imported
and matched, approved claims paid back with pay or by transfer, and reports and exports for the accountant. It does
not issue cards: their statements are imported.

```
expenses.yaml ──▶ expenses ◀── Payroll: GET /api/v1/payroll?month=, POST /api/v1/batches/{id}/paid
                     │ ▲
                     │ └── Time: GET /api/v1/project-costs
                     ├──▶ HR: GET /api/v1/employees (people, departments, managers)
                     ├──▶ Time: GET /api/v1/projects
                     ├──▶ TCMB: /kurlar/YYYYMM/DDMMYYYY.xml (exchange rates)
                     └──▶ a receipt reader on your network: POST /read (optional)
```

**No screens yet.** The Claims and Spend screens are not designed, so this release is the server and its API only;
there is no `web/` folder. Everything below is done through the API (reference at `/api/docs/`).

## Claims and items

A claim is one person's expenses sent together. It is a draft until it is sent, then waits for approval, and is
approved, rejected, or sent back as a draft. Approved claims are paid back in a batch. Each item is one of:

- **A receipt:** its total with KDV in its currency, the day on it, the seller and their VKN or TCKN (check digits
  verified), the document (`invoice` for a fatura, e-Arşiv or e-Fatura, `receipt` for a till receipt, `other`, `none`)
  and its number, and the photo or PDF. Without a file, it needs a reason, and finance approves the claim.
- **Mileage:** kilometres driven (one decimal) and the route, paid at the category's `rate` per km.
- **A daily allowance:** days away (in half days) and the country, at the category's rate for it or its `default`.

Each item has a category and, where the category allows or requires it, a project. **Money is whole numbers:** an
item's amount is in its currency's minor units (kuruş, cents, yen) and every TRY amount, total and limit in kuruş, so
nothing rounds twice. `64000` is 640.00 TL.

## Currencies and TCMB's rates

A receipt in another currency is turned into TRY at the rate TCMB published, fetched from
`https://www.tcmb.gov.tr/kurlar/YYYYMM/DDMMYYYY.xml` and kept. `rates.use` picks the rate (`forex_buying`, döviz alış,
by default) and `rates.day` the day: `previous` (the default) takes the rates announced on the last business day before
the receipt's date, the ones in force that day; `same` takes that day's, or the last before it. Weekends and holidays
have no file; they are remembered, so a day is asked once. Rates are kept as millionths of a lira per unit (TCMB gives
JPY per 100). When TCMB cannot be reached, the item keeps its rate pending, is tried again every 15 seconds, and the
claim cannot be sent until it is known. An item paid by company card takes what the card was charged instead.
`GET /api/v1/rates?currency=EUR&date=` shows the rate a receipt would get.

## KDV

KDV is recorded on TRY invoices and till receipts only; foreign VAT is not KDV and a receipt in another currency
carries none. Each item has one line per rate (`vat: [{ rate, amount }]`, rates from `kdv_rates`). Left out, it is the
category's `kdv` on the gross total (`gross × rate / (100 + rate)`); with one rate, the amount may be left out and is
worked out; with several, each rate's KDV is given as the receipt prints it. A rate's KDV can never be more than the
whole total would carry at that rate (a kuruş is allowed for rounding). Each item shows its KDV and its net.

## The policy

Set per category in the file, applied to every draft as it changes and kept as it was when the claim was sent:

| | |
| --- | --- |
| Limits | `per_item`, `per_day`, `per_month` in TRY, per person, counting this claim and their other sent claims |
| Over a limit | `flag`: finance approves it; `block`: the claim cannot be sent; `cap`: paid back up to the limit, the rest held |
| No receipt | Needs a reason, and finance approves the claim |
| Duplicates | A receipt with the same seller (without case, punctuation or the company form), date and amount as an earlier one is flagged, and the same file on another claim too; finance approves |
| Late | A receipt older than `receipts.max_age` (90 days) is flagged for finance |
| Read otherwise | When the amount or date entered differs from what the reader read, the approver sees it |
| Project | `project: required` stops a claim until its items have one |

## Approvals

The chain is the department's (`approvals.departments.<id>`) or the general one (`approvals.chain`). A step applies
when the claim's total is over its `over`. `manager` is the person's manager from HR (or `people` in the file);
`finance` is any member with the editor role; a step can also name a member by email.

- Without a manager, or when the step would land on the claimant, the step goes to finance. Nobody approves their own
  claim.
- The same person approves once: a later step for someone already in the chain is left out.
- Something the policy flags for finance adds a finance step at the end when the chain has none.
- A finance step is taken by an editor who is not the claimant and did not approve an earlier step of the same claim.
- Approve, reject (for good) and send back (to draft, with what to change) are the waiting step's. Rejecting and
  sending back need a reason. The claimant can withdraw a claim while it waits. Sending it again starts a new round.
- Finance passes a waiting step to another member (`POST /claims/{id}/reassign`): a manager away or not a member yet.
- A claim the company card paid in full is paid the moment it is approved: nothing is owed.

## Paying back

Finance puts approved claims in a batch, `payroll` or `transfer`, with a pay date, changes it while it is open, and
sends it, which locks it. A **payroll** batch is taken by Payroll from `GET /api/v1/payroll?month=YYYY-MM`: per person,
their email, HR id, amount and lines by category (with its account code) and project. Payroll calls
`POST /api/v1/batches/{id}/paid` once the run is paid, and the claims become paid. A **transfer** batch needs every
person's IBAN (they set it with `PUT /api/v1/me/iban`, check digits verified) and gives the bank's list as CSV
(`GET /api/v1/batches/{id}/transfers`: name, IBAN, amount, currency, description); finance marks it paid. What a capped
limit held back and what a company card paid are never paid back.

## Company cards

`POST /api/v1/cards/imports` takes the bank's CSV (comma, semicolon or tab, with lines about the account above the
table). The columns are found by their headers (`İşlem Tarihi`, `Açıklama`, `Tutar`, `Kart No`, `Para Birimi`,
`Orijinal Tutar` and their English names, or `cards.columns`). Payments to the card, refunds and total lines are
skipped (`cards.purchases` says which sign a purchase has). A line imported again is a duplicate; the same purchase
twice on one day counts twice. A purchase belongs to the holder of the card's last four digits (`cards.holders`) and
is matched to the holder's draft receipt with the same amount within `cards.match_days`; the receipt then is the
company's. A purchase with no receipt yet is listed to its holder (`GET /api/v1/cards/transactions?state=unmatched`),
who adds it to a claim with `cardTransaction`. `check: true` reads the file and changes nothing.

## Receipts

`POST /api/v1/receipts` takes the file as the body and its name in `x-file-name`. A file is taken only when its bytes
are one of `receipts.types` (JPEG, PNG, WebP, HEIC, PDF), whatever it was sent as, and at most `receipts.max_size`
(10 MB). A PDF that carries scripts or launches or embeds files is refused.

**Metadata is removed before a file is kept** (`server/strip.ts`, no native library): EXIF with the GPS position, the
phone and the time, XMP, IPTC (Photoshop) and comments. A JPEG keeps its image segments, JFIF, colour profile and
Adobe segment, and a new EXIF segment with the orientation tag alone, so a photo taken sideways still shows upright;
its image data is copied byte for byte. PNG loses its `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME` chunks, WebP its
`EXIF` and `XMP` chunks (and their flags). HEIC cannot be rewritten without moving its image data, so the bytes of its
Exif and XMP items are overwritten with zeros in place; its rotation is a property of the image there and stays. An
image whose metadata cannot be found and removed is refused (415). PDFs are kept as sent: their document information
(author, producer) is not removed. The reader is sent the file as kept.

The sha256 is of the file as kept, after the metadata is removed: the same photo sent twice by the same person answers
with the receipt it made, whatever metadata each copy carried, and the duplicate check across claims compares those
hashes too. Files are kept in the database, so its backup has them. They are served with
`content-security-policy: default-src 'none'; sandbox` and `nosniff`: JPEG, PNG and WebP inline, PDF and HEIC as a
download, and only to their owner, the approvers of a claim they are on, and viewers.

**Reading receipts.** Expenses reads nothing itself. With `receipts.reader` in the file, each receipt is posted to
`<url>/read` (the file as the body, its type as `content-type`, the token as a bearer token), in the background, and
the answer is kept:

```json
{ "confidence": 0.93, "amount": "640.00", "currency": "TRY", "date": "2026-10-30", "seller": "Kuzu Lokantası",
  "taxNumber": "1234567890", "documentNumber": "GIB2026000001234", "vat": [{ "rate": 10, "amount": "58.18" }] }
```

Amounts are in the currency's units; anything that does not read as its type is left out. Below `min_confidence`
(0.8) the receipt is `unclear` and nothing is filled. An item made with the receipt takes the fields it leaves out
from what was read (listed in `readUsed`). Any OCR you run on your network can sit behind this with a small adapter;
none is shipped, and on unclear photos people type the fields in.

## Reports and exports

By the day on the receipt; approved and paid claims, and submitted ones with `include=submitted`:

- `GET /api/v1/reports/spend?by=category|department|project|person|month`: total, KDV, net, what the card paid and
  what is paid back.
- `GET /api/v1/reports/policy`: items of sent claims the policy flagged.
- `GET /api/v1/reports/kdv`: KDV by rate (with its base) and by document.
- `GET /api/v1/exports/items`: every item as CSV for the accountant, one column per KDV rate, with the account code,
  the TCMB rate and its day, the employee id and the receipt's name in the receipts export. Separated by `;` with a
  decimal comma by default (`exports`), with a byte order mark so Excel reads it as UTF-8; cells a spreadsheet would
  run as a formula start with `'`.
- `GET /api/v1/exports/receipts`: the period's receipts as a ZIP, by claim.

## Who sees what

Roles are the members' roles under Members (ADR 0003). Everyone who spends for the company is a member with the
**user** role: they send their own claims, see their own card purchases and approve the steps that name them, and see
nobody else's claims. **Viewers** read every claim, the reports and the exports. **Editors** are finance: they take
finance steps, pass steps on, pay batches and import card statements. **Admins** also manage members and tokens.
Claims and receipts belong to a signed-in person; an API token keeps none.

## What other products call, and what Expenses calls

**HR.** With `hr` in the file, Expenses reads `GET /api/v1/employees?status=current` every `every` (15 minutes) with
an HR token of the viewer role: each employee's work email, department and manager (by id, resolved to the manager's
work email from the same list), as `hr/openapi.json` gives them. A department HR names is matched to the file's by id
or name, so its approval chain applies. When HR cannot be reached, the people last read stay. Without HR, the file's
`people` are used.

**Time.** With `time` in the file, projects are read from `GET /api/v1/projects` (each `{ id or code, name, status }`)
with a Time token. Time has published no API yet; this is the shape Expenses reads. Without Time, the file's
`projects`. Time shows what was spent on a project from `GET /api/v1/project-costs?from=&to=&project=` with an
Expenses token of the viewer role: approved and paid spending per project, with KDV and by category.

**Payroll** reads `GET /api/v1/payroll?month=` with an Expenses token of the viewer role and marks a batch paid with a
token of the editor role, as above. Payroll is not built yet; this is Expenses' side of the link.

## The settings file

Everything but the claims is in [config/expenses.yaml](./config/expenses.yaml), read at start and again within a minute
of a change, applied whole or not at all; a file with a mistake leaves the last good version in place.
`GET /api/v1/settings` shows it as applied; `GET /api/v1/policy` gives members the categories and rates.

| Key | Default | |
| --- | --- | --- |
| `time_zone` | `Europe/Istanbul` | What today is, for dates and months |
| `currencies` | every TCMB currency | Currencies receipts may be in, other than TRY |
| `rates` | `forex_buying`, `previous` | `{ use, day, url }`: which TCMB rate and which day's |
| `receipts` | 10MB, all five types, 90d | `{ max_size, types, max_age, reader: { url, token, min_confidence } }` |
| `kdv_rates` | `[0%, 1%, 10%, 20%]` | The KDV rates receipts may carry |
| `categories.<id>` | travel, meals, other | `{ name, kind, account, kdv, limit: { per_item, per_day, per_month }, over_limit, project, rate, rates }` |
| `approvals` | the manager | `{ chain: [manager \| finance \| email \| { approver, over }], departments: { <id>: [...] } }` |
| `departments` | | `<id>: <name>` |
| `people` | | `<email>: { name, department, manager, employee_id }`, used until HR is linked |
| `projects` | | `<id>: <name>`, used until Time is linked |
| `cards` | 3 days, positive | `{ holders: { "<last four>": <email> }, match_days, purchases, columns }` |
| `exports` | `;` and `,` | `{ separator, decimal }` for the CSVs |
| `hr`, `time` | | `{ url, token, every }`; `token` names a variable |

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/expenses.yaml
docker compose up -d
docker compose logs expenses | grep 'no owner yet'
```

There is no default password (ADR 0013). Until the screens exist, the first start's link opens nothing; post its
`setup` token to the API, then add an authenticator app (`/api/v1/auth/me/totp`), as owners must, before adding members
and tokens:

```bash
curl -X POST http://localhost:8080/api/v1/auth/setup -H 'content-type: application/json' \
  -d '{"token":"<setup from the link>","name":"Selin Aydın","email":"selin@example.com","password":"<12 or more characters>"}'
```

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `EXPENSES_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `EXPENSES_CONFIG` | `/config/expenses.yaml` | The settings file |
| the variables the file names | | HR's and Time's tokens, the reader's |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `EXPENSES_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key: sign-in secrets |
| `EXPENSES_DB` | `/data/expenses.db` | SQLite file (WAL) with the receipts' files, on the `/data` volume |
| `EXPENSES_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `EXPENSES_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)); `OPENASY_OIDC_DEFAULT_ROLE=user` lets everyone in your provider send claims |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Metrics
include claims by state, waiting steps, rates pending, receipts being read, unmatched card purchases, each link's last
result and decisions by result. Query strings are not written to the request log.

## Develop

```bash
npm install
npm test           # money in whole numbers, TCMB's files and holidays, KDV, the policy and its limits, the approval
                   # chain, receipts by their bytes and how they are served, card statements, batches and Payroll's
                   # month, reports, the CSV and ZIP exports, HR and Time against fakes, and every API response
                   # against openapi.json
npm run openapi    # writes openapi.json after an API change; a test fails while it is out of date
npm start          # the API on :8080, with EXPENSES_CONFIG=config/expenses.yaml EXPENSES_DB=./data/expenses.db
```

What is tested against fakes only: TCMB's files are served by `server/fakes.ts` in the layout of TCMB's `today.xml`;
the real site, its holiday files and its publication time are not called in tests. HR's employees follow
`hr/openapi.json` as it is now; Time's projects and the receipt reader follow the shapes described above, since
neither is published.

## Licence

AGPL-3.0 (ADR 0008).
