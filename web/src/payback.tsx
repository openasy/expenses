// Paying back: approved claims go into batches, paid with pay (Payroll takes the month's batches) or by bank transfer
// from a list uploaded to the bank. A batch is locked when it is sent and marked paid when the money is out.
import { Button, Callout, Checkbox, Dialog, IconButton, PageHeader, Panel, SelectField, StatusBadge, TextField, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Banknote, FileDown, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Batch, BatchDetail, BatchMethod, Claim } from "./api.ts";
import { BATCH_TONE, day, money, Notice, patch, post, today, useLoad, type Note } from "./common.tsx";
import { useT } from "./i18n.ts";

function BatchPanel({ ctx, batch, onChanged, onNote }: { ctx: Ctx; batch: Batch; onChanged: () => void; onNote: (n: Note) => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [detail, reload] = useLoad<BatchDetail>(ctx.call, `/api/v1/batches/${batch.id}`);
  const [paying, setPaying] = useState(false);
  const [paidOn, setPaidOn] = useState(today());
  const finance = can("editor");
  const run = (req: Promise<unknown>, text: string) =>
    void req.then(
      () => {
        onNote({ text });
        reload();
        onChanged();
      },
      (err: Error) => onNote({ text: err.message, tone: "danger" }),
    );
  const amount = money(batch.total, "TRY", locale);
  return (
    <Panel
      aria-label={batch.number}
      title={batch.number}
      description={`${t(batch.method === "payroll" ? "payback.withPay" : "payback.byTransfer")} · ${day(batch.payDate, locale)}`}
      actions={<StatusBadge tone={BATCH_TONE[batch.state]}>{t(`batch.${batch.state}`)}</StatusBadge>}
      footer={
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {t("payback.claimsN", { count: batch.claims })} · {t("payback.peopleN", { count: batch.people })} · {amount}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {finance && batch.state === "open" && (
              <>
                <IconButton
                  label={t("payback.remove", { number: batch.number })}
                  size="xs"
                  onClick={() => run(ctx.call(`/api/v1/batches/${batch.id}`, { method: "DELETE" }), t("payback.removed", { number: batch.number }))}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
                <Button
                  size="xs"
                  variant="primary"
                  icon={<Send />}
                  disabled={!batch.claims || batch.missingIban.length > 0}
                  onClick={() =>
                    run(
                      ctx.call(`/api/v1/batches/${batch.id}/send`, post()),
                      t(batch.method === "payroll" ? "payback.sentPayroll" : "payback.sentTransfer", {
                        number: batch.number,
                        amount,
                        day: day(batch.payDate, locale),
                      }),
                    )
                  }
                >
                  {t(batch.method === "payroll" ? "payback.sendPayroll" : "payback.lock")}
                </Button>
              </>
            )}
            {finance && batch.method === "transfer" && batch.state !== "open" && (
              <a
                href={`/api/v1/batches/${batch.id}/transfers`}
                download
                aria-label={t("payback.download", { number: batch.number })}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-line-strong px-2 text-xs text-fg no-underline hover:bg-subtle"
              >
                <FileDown aria-hidden className="size-3.5" />
                {t("payback.transferList")}
              </a>
            )}
            {finance && batch.state === "sent" && (
              <Button size="xs" icon={<Banknote />} onClick={() => setPaying(true)}>
                {t("payback.markPaid")}
              </Button>
            )}
          </span>
        </span>
      }
    >
      {batch.missingIban.length > 0 && (
        <Callout tone="warning" title={t("payback.noIban")} className="mb-2">
          {batch.missingIban.join(", ")}
        </Callout>
      )}
      {detail ? (
        <ul aria-label={t("payback.claimsIn", { number: batch.number })} className="exp-list flex flex-col gap-1.5 text-xs">
          {detail.lines.map((l) => (
            <li key={l.person.email} className="flex flex-col">
              <span className="flex justify-between gap-2">
                <span className="text-fg">{l.person.name}</span>
                <span className="font-mono">{money(l.amount, "TRY", locale)}</span>
              </span>
              <span className="text-2xs text-fg-muted">
                {l.claims.map((c) => (
                  <a key={c.id} href={`/all/${c.id}`} className="me-1.5">
                    {c.number}
                  </a>
                ))}
                {batch.method === "transfer" &&
                  (l.iban ? <span className="font-mono">{l.iban}</span> : <span className="text-warning-text">{t("payback.noIbanOne")}</span>)}
              </span>
            </li>
          ))}
          {!detail.lines.length && <li className="text-fg-muted">{t("payback.empty")}</li>}
        </ul>
      ) : (
        <p className="m-0 text-xs text-fg-muted">{detail === null ? t("loadFailed") : t("loading")}</p>
      )}
      {batch.state === "paid" && batch.paidAt && (
        <p className="mb-0 mt-2 text-2xs text-fg-muted">{t("payback.paidBy", { day: day(batch.paidAt.slice(0, 10), locale), by: batch.paidBy ?? "" })}</p>
      )}
      <Dialog
        open={paying}
        onOpenChange={setPaying}
        title={t("payback.paidTitle", { number: batch.number })}
        description={t("payback.paidDetail")}
        onSubmit={(e) => {
          e.preventDefault();
          setPaying(false);
          run(ctx.call(`/api/v1/batches/${batch.id}/paid`, post({ paidOn })), t("payback.paid", { number: batch.number }));
        }}
        footer={
          <>
            <Button type="button" onClick={() => setPaying(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary">
              {t("payback.markPaid")}
            </Button>
          </>
        }
      >
        <TextField label={t("payback.paidOn")} type="date" value={paidOn} max={today()} onChange={(e) => setPaidOn(e.target.value)} required />
      </Dialog>
    </Panel>
  );
}

export function PayBackPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [claims, reloadClaims] = useLoad<{ claims: Claim[] }>(ctx.call, "/api/v1/claims?scope=all&state=approved");
  const [batches, reloadBatches] = useLoad<{ batches: Batch[] }>(ctx.call, "/api/v1/batches");
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [creating, setCreating] = useState(false);
  const [method, setMethod] = useState<BatchMethod>("payroll");
  const [payDate, setPayDate] = useState(today());
  const [into, setInto] = useState("");
  const finance = can("editor");
  const ready = (claims?.claims ?? []).filter((c) => !c.batch && c.reimbursable > 0);
  const open = (batches?.batches ?? []).filter((b) => b.state === "open");
  const changed = () => {
    reloadClaims();
    reloadBatches();
    ctx.onChanged();
  };
  const fail = (err: Error) => setNote({ text: err.message, tone: "danger" });
  const target = open.find((b) => b.id === into) ?? open[0];
  return (
    <>
      <PageHeader title={t("payback.title")} description={t("payback.description")} />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <Panel
        title={t("payback.ready")}
        aria-label={t("payback.ready")}
        className="mb-2.5"
        description={
          ready.length
            ? money(
                ready.reduce((n, c) => n + c.reimbursable, 0),
                "TRY",
                locale,
              )
            : undefined
        }
        actions={
          finance && (
            <span className="flex flex-wrap items-center gap-1.5">
              {open.length > 0 && (
                <>
                  {open.length > 1 && (
                    <SelectField
                      aria-label={t("payback.into")}
                      value={target?.id ?? ""}
                      onChange={(e) => setInto(e.target.value)}
                      options={open.map((b) => ({ value: b.id, label: b.number }))}
                    />
                  )}
                  <Button
                    size="sm"
                    disabled={!picked.length || !target}
                    onClick={() =>
                      void ctx.call(`/api/v1/batches/${target!.id}`, patch({ add: picked })).then(() => {
                        setNote({ text: t("payback.added", { count: picked.length, number: target!.number }) });
                        setPicked([]);
                        changed();
                      }, fail)
                    }
                  >
                    {t("payback.addTo", { number: target?.number ?? "" })}
                  </Button>
                </>
              )}
              <Button size="sm" variant="primary" icon={<Plus />} disabled={!ready.length} onClick={() => setCreating(true)}>
                {t("payback.newBatch")}
              </Button>
            </span>
          )
        }
      >
        <ul aria-label={t("payback.readyList")} className="exp-list flex flex-col gap-2">
          {ready.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3 border-b border-subtle pb-2 last:border-0">
              {finance ? (
                <Checkbox
                  label={`${c.owner.name}: ${c.title}`}
                  description={`${c.number} · ${money(c.reimbursable, "TRY", locale)}`}
                  checked={picked.includes(c.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                />
              ) : (
                <span className="flex flex-col text-sm">
                  <a href={`/all/${c.id}`}>
                    {c.owner.name}: {c.title}
                  </a>
                  <span className="text-xs text-fg-muted">
                    {c.number} · {money(c.reimbursable, "TRY", locale)}
                  </span>
                </span>
              )}
            </li>
          ))}
          {claims && !ready.length && <li className="text-xs text-fg-muted">{t("payback.allInBatch")}</li>}
        </ul>
      </Panel>
      <div className="exp-halves grid gap-2.5">
        {(batches?.batches ?? []).map((b) => (
          <BatchPanel key={`${b.id}-${b.state}-${b.claims}-${b.total}`} ctx={ctx} batch={b} onChanged={changed} onNote={setNote} />
        ))}
      </div>
      {batches && !batches.batches.length && <p className="text-sm text-fg-muted">{t("payback.noBatches")}</p>}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={t("payback.newBatch")}
        description={picked.length ? t("payback.newPicked", { count: picked.length }) : t("payback.newAll", { count: ready.length })}
        onSubmit={(e) => {
          e.preventDefault();
          setCreating(false);
          void ctx.call<BatchDetail>("/api/v1/batches", post({ method, payDate, ...(picked.length && { claims: picked }) })).then((b) => {
            setNote({ text: t("payback.created", { number: b.number, count: b.claims, amount: money(b.total, "TRY", locale) }) });
            setPicked([]);
            changed();
          }, fail);
        }}
        footer={
          <>
            <Button type="button" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary">
              {t("payback.create")}
            </Button>
          </>
        }
      >
        <SelectField
          label={t("payback.method")}
          value={method}
          onChange={(e) => setMethod(e.target.value as BatchMethod)}
          options={[
            { value: "payroll", label: t("payback.withPay") },
            { value: "transfer", label: t("payback.byTransfer") },
          ]}
        />
        <TextField label={t("payback.payDate")} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} required />
      </Dialog>
    </>
  );
}
