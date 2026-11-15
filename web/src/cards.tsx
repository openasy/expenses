// Company cards: purchases from the bank's statement, given to their holder by the card's last four digits, and
// matched to a receipt on a claim. Finance imports the statement; holders see their own purchases.
import { Button, DataTable, Dialog, PageHeader, Panel, SegmentedControl, StatusBadge, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Upload } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { CardImport, CardTransaction } from "./api.ts";
import { FileButton, money, Notice, post, shortDay, useLoad, when, type Note } from "./common.tsx";
import { useT } from "./i18n.ts";

function ImportDialog({ ctx, onClose, onDone }: { ctx: Ctx; onClose: () => void; onDone: (text: string) => void }) {
  const t = useT();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [check, setCheck] = useState<CardImport | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const send = (dry: boolean, f = file) => {
    if (!f) return;
    setNote(null);
    setBusy(true);
    void ctx.call<CardImport>("/api/v1/cards/imports", post({ csv: f.csv, filename: f.name, check: dry })).then(
      (r) => {
        setBusy(false);
        if (dry) setCheck(r);
        else onDone(t("cards.imported", { file: f.name, added: r.added, duplicates: r.duplicates, matched: r.matched }));
      },
      (err: Error) => {
        setBusy(false);
        setCheck(null);
        setNote({ text: err.message, tone: "danger" });
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("cards.importTitle")}
      description={t("cards.importDetail")}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!check || !check.added || check.errors.length > 0} loading={busy} onClick={() => send(false)}>
            {t("cards.import")}
          </Button>
        </>
      }
    >
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-3 text-sm text-fg">
        <FileButton
          label={file ? t("cards.otherFile") : t("cards.pickFile")}
          accept=".csv,text/csv,text/plain"
          icon={<Upload />}
          primary={!file}
          onFile={(f) =>
            void f.text().then((csv) => {
              const next = { name: f.name, csv };
              setFile(next);
              send(true, next);
            })
          }
        />
        {file && <span className="font-mono text-xs">{file.name}</span>}
      </div>
      {check && (
        <ul aria-label={t("cards.checkResult")} className="exp-list mt-2.5 flex flex-col gap-1 text-sm">
          <li>{t("cards.willAdd", { count: check.added })}</li>
          {check.duplicates > 0 && <li className="text-fg-muted">{t("cards.duplicates", { count: check.duplicates })}</li>}
          {check.matched > 0 && <li className="text-fg-muted">{t("cards.willMatch", { count: check.matched })}</li>}
          {check.withoutHolder > 0 && <li className="text-warning-text">{t("cards.withoutHolder", { count: check.withoutHolder })}</li>}
          {check.skipped > 0 && <li className="text-fg-muted">{t("cards.skipped", { count: check.skipped })}</li>}
          {check.errors.map((e) => (
            <li key={e.line} className="text-danger-text">
              {t("cards.lineError", { line: e.line, error: e.error })}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function CardsPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [show, setShow] = useState<"all" | "unmatched">("all");
  const [txs, reload] = useLoad<{ transactions: CardTransaction[] }>(ctx.call, `/api/v1/cards/transactions?state=${show}`);
  const [imports, reloadImports] = useLoad<{
    imports: Array<{ id: string; filename: string | null; by: string; at: string; added: number; duplicates: number }>;
  }>(ctx.call, can("viewer") ? "/api/v1/cards/imports" : null);
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const base = can("viewer") ? "all" : "mine";
  return (
    <>
      <PageHeader
        title={t("cards.title")}
        description={t("cards.description", { days: ctx.settings?.config?.cards.matchDays ?? 3 })}
        actions={
          can("editor") && (
            <Button icon={<Upload />} onClick={() => setImporting(true)}>
              {t("cards.importButton")}
            </Button>
          )
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <div className="mb-2.5">
        <SegmentedControl
          label={t("cards.show")}
          value={show}
          onChange={setShow}
          options={[
            { value: "all", label: t("cards.all") },
            { value: "unmatched", label: t("cards.waiting") },
          ]}
        />
      </div>
      <Panel flush className="mb-2.5">
        <DataTable
          label={t("cards.purchases")}
          rows={txs?.transactions ?? []}
          loading={txs === undefined}
          empty={txs === null ? t("loadFailed") : t("cards.none")}
          getRowId={(l) => l.id}
          minWidth={760}
          columns={[
            { id: "date", header: t("cards.date"), sortValue: (l) => l.date, cell: (l) => shortDay(l.date, locale) },
            { id: "seller", header: t("cards.seller"), cell: (l) => <span className="font-mono text-xs">{l.description}</span> },
            {
              id: "holder",
              header: t("cards.holder"),
              cell: (l) => (
                <span className="flex flex-col">
                  <span className="text-xs">{l.holder ?? t("cards.noHolder")}</span>
                  {l.card && <span className="font-mono text-2xs text-fg-muted">•••• {l.card}</span>}
                </span>
              ),
            },
            {
              id: "amount",
              header: t("cards.amount"),
              align: "right",
              mono: true,
              sortValue: (l) => l.amountTry,
              cell: (l) => (
                <span className="flex flex-col items-end">
                  {money(l.amountTry, "TRY", locale)}
                  {l.currency && l.currency !== "TRY" && l.amount !== null && (
                    <span className="text-2xs text-fg-muted">{money(l.amount, l.currency, locale)}</span>
                  )}
                </span>
              ),
            },
            {
              id: "state",
              header: t("cards.receipt"),
              cell: (l) =>
                l.item ? (
                  <a href={`/${base}/${l.item.claim}`}>
                    <StatusBadge tone="success">{t("cards.on", { number: l.item.number })}</StatusBadge>
                  </a>
                ) : (
                  <StatusBadge tone="warning">{t("cards.waitingOne")}</StatusBadge>
                ),
            },
          ]}
        />
      </Panel>
      {imports?.imports.length ? (
        <Panel title={t("cards.imports")} aria-label={t("cards.imports")}>
          <ul className="exp-list flex flex-col gap-1 text-xs">
            {imports.imports.slice(0, 10).map((i) => (
              <li key={i.id} className="flex flex-wrap justify-between gap-2">
                <span className="font-mono">{i.filename ?? "–"}</span>
                <span className="text-fg-muted">{t("cards.importLine", { added: i.added, duplicates: i.duplicates, by: i.by, at: when(i.at, locale) })}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {importing && (
        <ImportDialog
          ctx={ctx}
          onClose={() => setImporting(false)}
          onDone={(text) => {
            setImporting(false);
            setNote({ text });
            reload();
            reloadImports();
            ctx.onChanged();
          }}
        />
      )}
    </>
  );
}
