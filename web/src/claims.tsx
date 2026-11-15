// Claims: my claims, the ones waiting for my approval, every sent claim, and one claim with its items, who approves
// it and what happened to it.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  FacetFilter,
  FilterBar,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  SegmentedControl,
  TextField,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowLeft, Camera, Car, Pencil, Plane, Plus, Receipt, Send, Trash2, Undo2, UserRoundCog } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Claim, ClaimDetail, ClaimState, Item, ItemKind, Me, Step } from "./api.ts";
import { ClaimBadge, day, money, Notice, num, patch, post, put, shortDay, today, useLoad, when, type Note, pct } from "./common.tsx";
import { useT, type T } from "./i18n.ts";
import { ItemDialog } from "./item.tsx";

export type ClaimPageId = "mine" | "approve" | "all";

const KIND_ICON = { receipt: Receipt, mileage: Car, per_diem: Plane } as const;
const HISTORY = ["created", "submitted", "withdrawn", "approved", "rejected", "returned", "reassigned", "in payment", "paid"];

// ---------------------------------------------------------------- lists

function ClaimsList({
  claims,
  label,
  base,
  showOwner,
  empty,
}: {
  claims: Claim[] | null | undefined;
  label: string;
  base: ClaimPageId;
  showOwner?: boolean;
  empty?: string;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const cols: Column<Claim>[] = [
    {
      id: "title",
      header: t("claims.claim"),
      width: "32%",
      sortValue: (c) => c.title,
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <a href={`/${base}/${c.id}`} className="truncate font-medium text-fg">
            {c.title}
          </a>
          <span className="font-mono text-2xs text-fg-muted">{c.number}</span>
        </span>
      ),
    },
    ...(showOwner
      ? [
          {
            id: "owner",
            header: t("claims.person"),
            sortValue: (c: Claim) => c.owner.name,
            cell: (c: Claim) => (
              <span className="flex items-center gap-1.5">
                <Avatar name={c.owner.name} size="sm" />
                <span className="flex flex-col">
                  <span className="text-xs">{c.owner.name}</span>
                  <span className="text-2xs text-fg-muted">{c.department?.name ?? "–"}</span>
                </span>
              </span>
            ),
          },
        ]
      : []),
    { id: "state", header: t("claims.state"), sortValue: (c) => c.state, cell: (c) => <ClaimBadge state={c.state} t={t} /> },
    {
      id: "flags",
      header: t("claims.flags"),
      sortValue: (c) => c.flags.count,
      cell: (c) =>
        c.flags.count ? (
          <span className="flex flex-wrap gap-1">
            <Badge tone={c.flags.blocking ? "danger" : c.flags.finance ? "warning" : "neutral"}>{t("claims.flagsN", { count: c.flags.count })}</Badge>
            {c.flags.finance > 0 && <Badge tone="warning">{t("claims.finance")}</Badge>}
          </span>
        ) : (
          <span className="text-xs text-fg-muted">–</span>
        ),
    },
    {
      id: "sent",
      header: t("claims.sent"),
      sortValue: (c) => c.submittedAt ?? "",
      cell: (c) => (c.submittedAt ? shortDay(c.submittedAt.slice(0, 10), locale) : "–"),
    },
    {
      id: "total",
      header: t("claims.paidBack"),
      align: "right",
      mono: true,
      sortValue: (c) => c.reimbursable,
      cell: (c) => money(c.reimbursable, "TRY", locale),
    },
  ];
  return (
    <DataTable
      label={label}
      columns={cols}
      rows={claims ?? []}
      loading={claims === undefined}
      empty={claims === null ? t("loadFailed") : (empty ?? t("claims.none"))}
      getRowId={(c) => c.id}
      minWidth={showOwner ? 860 : 700}
      onRowClick={(c) => navigate(`/${base}/${c.id}`)}
    />
  );
}

function NewClaim({ ctx, open, onOpenChange }: { ctx: Ctx; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [note, setNote] = useState<Note>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("claims.new")}
      description={t("claims.newDetail")}
      onSubmit={(e) => {
        e.preventDefault();
        setNote(null);
        void ctx.call<ClaimDetail>("/api/v1/claims", post({ title: title.trim() })).then(
          (c) => {
            ctx.onChanged();
            navigate(`/mine/${c.id}`);
          },
          (err: Error) => setNote({ text: err.message, tone: "danger" }),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim()}>
            {t("claims.create")}
          </Button>
        </>
      }
    >
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <TextField label={t("claims.title")} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("claims.titleExample")} maxLength={120} />
    </Dialog>
  );
}

function IbanDialog({ ctx, open, onOpenChange, onSaved }: { ctx: Ctx; open: boolean; onOpenChange: (o: boolean) => void; onSaved: (m: Me) => void }) {
  const t = useT();
  const [iban, setIban] = useState("");
  const [note, setNote] = useState<Note>(null);
  const save = (value: string | null) => {
    setNote(null);
    void ctx.call<Me>("/api/v1/me/iban", put({ iban: value })).then(
      (m) => {
        onSaved(m);
        onOpenChange(false);
      },
      (err: Error) => setNote({ text: err.message, tone: "danger" }),
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("mine.iban")}
      description={t("mine.ibanDetail")}
      onSubmit={(e) => {
        e.preventDefault();
        save(iban.trim());
      }}
      footer={
        <>
          {ctx.me.iban && (
            <Button type="button" variant="danger" onClick={() => save(null)}>
              {t("mine.ibanRemove")}
            </Button>
          )}
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!iban.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <TextField label="IBAN" mono value={iban} onChange={(e) => setIban(e.target.value)} placeholder="TR33 0006 1005 1978 6457 8413 26" />
    </Dialog>
  );
}

export function MinePage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [claims] = useLoad<{ claims: Claim[] }>(ctx.call, "/api/v1/claims?scope=mine");
  const [creating, setCreating] = useState(false);
  const [editingIban, setEditingIban] = useState(false);
  const list = claims?.claims;
  const drafts = (list ?? []).filter((c) => c.state === "draft");
  const year = today().slice(0, 4);
  const paidThisYear = (list ?? []).filter((c) => c.state === "paid" && c.paidAt?.startsWith(year));
  const owedBatch = (list ?? []).find((c) => c.state === "approved" && c.batch);
  const canClaim = !!ctx.me.member.email;
  return (
    <>
      <PageHeader
        title={t("mine.title")}
        description={t("mine.description")}
        actions={
          canClaim && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t("claims.new")}
            </Button>
          )
        }
      />
      {!canClaim && (
        <Callout tone="info" title={t("mine.noEmail")} className="mb-2.5">
          {t("mine.noEmailDetail")}
        </Callout>
      )}
      <KpiGrid minWidth={170} className="mb-2.5">
        <KpiCard
          label={t("mine.drafts")}
          value={
            list
              ? money(
                  drafts.reduce((n, c) => n + c.reimbursable, 0),
                  "TRY",
                  locale,
                )
              : "–"
          }
          delta={{ label: t("mine.draftsN", { count: drafts.length }), intent: "neutral" }}
        />
        <KpiCard
          label={t("mine.owed")}
          value={money(ctx.summary?.owed ?? 0, "TRY", locale)}
          delta={{
            label: owedBatch?.batch
              ? t(owedBatch.batch.method === "payroll" ? "mine.owedPayroll" : "mine.owedTransfer", { day: day(owedBatch.batch.payDate, locale) })
              : t("mine.owedDetail"),
            intent: "neutral",
          }}
        />
        <KpiCard
          label={t("mine.paidThisYear")}
          value={
            list
              ? money(
                  paidThisYear.reduce((n, c) => n + c.reimbursable, 0),
                  "TRY",
                  locale,
                )
              : "–"
          }
          delta={{ label: t("mine.claimsN", { count: paidThisYear.length }), intent: "neutral" }}
        />
      </KpiGrid>
      <Panel flush>
        <ClaimsList claims={claims === null ? null : list} label={t("mine.title")} base="mine" empty={t("mine.none")} />
      </Panel>
      <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
        {ctx.me.iban ? t("mine.ibanSet", { iban: ctx.me.iban }) : t("mine.ibanUnset")}
        {canClaim && (
          <Button size="xs" variant="ghost" onClick={() => setEditingIban(true)}>
            {ctx.me.iban ? t("mine.ibanChange") : t("mine.ibanAdd")}
          </Button>
        )}
      </p>
      {creating && <NewClaim ctx={ctx} open={creating} onOpenChange={setCreating} />}
      {editingIban && <IbanDialog ctx={ctx} open={editingIban} onOpenChange={setEditingIban} onSaved={() => ctx.onChanged()} />}
    </>
  );
}

export function ApprovePage(ctx: Ctx) {
  const t = useT();
  const [waiting] = useLoad<{ claims: Claim[] }>(ctx.call, "/api/v1/claims?scope=approvals");
  const [decided] = useLoad<{ claims: Claim[] }>(ctx.call, "/api/v1/claims?scope=decided");
  return (
    <>
      <PageHeader title={t("approve.title")} description={t("approve.description")} />
      {waiting?.claims.length === 0 && <Callout tone="success" title={t("approve.nothing")} className="mb-2.5" />}
      <Panel title={t("approve.waiting")} flush className="mb-2.5">
        <ClaimsList claims={waiting === null ? null : waiting?.claims} label={t("approve.waiting")} base="approve" showOwner empty={t("approve.nothing")} />
      </Panel>
      <Panel title={t("approve.decided")} flush>
        <ClaimsList
          claims={decided === null ? null : decided?.claims.filter((c) => c.owner.id !== ctx.me.member.id)}
          label={t("approve.decided")}
          base="approve"
          showOwner
          empty={t("approve.noneDecided")}
        />
      </Panel>
    </>
  );
}

export function AllPage(ctx: Ctx) {
  const t = useT();
  const [state, setState] = useState<"all" | ClaimState>("all");
  const [depts, setDepts] = useState<string[]>([]);
  const states = state === "all" ? "submitted,approved,paid,rejected" : state;
  const [claims] = useLoad<{ claims: Claim[] }>(ctx.call, `/api/v1/claims?scope=all&state=${states}`);
  const all = claims?.claims;
  const deptOf = (c: Claim) => c.department?.name ?? t("all.noDepartment");
  const deptNames = [...new Set((all ?? []).map(deptOf))].sort();
  const rows = all?.filter((c) => !depts.length || depts.includes(deptOf(c)));
  return (
    <>
      <PageHeader title={t("all.title")} description={t("all.description")} />
      <div className="mb-2.5">
        <FilterBar onClear={depts.length ? () => setDepts([]) : undefined}>
          <SegmentedControl
            label={t("claims.state")}
            value={state}
            onChange={setState}
            options={[
              { value: "all", label: t("all.every") },
              { value: "submitted", label: t("all.waiting") },
              { value: "approved", label: t("state.approved") },
              { value: "paid", label: t("state.paid") },
              { value: "rejected", label: t("state.rejected") },
            ]}
          />
          <FacetFilter
            label={t("all.department")}
            options={deptNames.map((d) => ({ value: d, count: (all ?? []).filter((c) => deptOf(c) === d).length }))}
            selected={depts}
            onChange={setDepts}
          />
        </FilterBar>
      </div>
      <Panel flush>
        <ClaimsList claims={claims === null ? null : rows} label={t("all.title")} base="all" showOwner />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- one claim

function ItemsTable({ claim, onEdit, onRemove }: { claim: ClaimDetail; onEdit?: (i: Item) => void; onRemove?: (i: Item) => void }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const m = (n: number, c = "TRY") => money(n, c, locale);
  const detail = (i: Item) =>
    [
      shortDay(i.date, locale),
      i.project?.name,
      i.kind === "mileage" && i.km !== null ? t("item.kmN", { km: num(i.km, locale, 1) }) : null,
      i.kind === "per_diem" && i.days !== null ? t("item.daysN", { days: num(i.days, locale, 1), country: i.country ?? "" }) : null,
      i.kind === "receipt" ? (i.receipt ? (i.readUsed.length ? t("item.receiptRead") : t("item.receiptAttached")) : t("item.noReceipt")) : null,
      i.paidBy === "company" ? t("item.companyCard") : null,
      i.description,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <caption className="sr-only">{t("claim.items")}</caption>
        <thead className="bg-canvas text-xs text-fg-muted">
          <tr>
            <th className="px-3 py-1.5 font-semibold">{t("claim.item")}</th>
            <th className="px-3 py-1.5 font-semibold">{t("claim.category")}</th>
            <th className="px-3 py-1.5 text-end font-semibold">{t("claim.amount")}</th>
            <th className="px-3 py-1.5 text-end font-semibold">KDV</th>
            <th className="px-3 py-1.5 text-end font-semibold">{t("claims.paidBack")}</th>
            {(onEdit || onRemove) && (
              <th className="px-3 py-1.5">
                <span className="sr-only">{t("claim.actions")}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {claim.lines.map((i) => {
            const Icon = KIND_ICON[i.kind];
            const name = i.seller ?? i.route ?? i.category.name;
            return (
              <tr key={i.id} className="border-t border-line align-top">
                <td className="px-3 py-1.5">
                  <span className="flex items-start gap-2">
                    <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />
                    <span className="flex min-w-0 flex-col">
                      {i.receipt ? (
                        <a href={i.receipt.url} target="_blank" rel="noreferrer" className="text-fg">
                          {name}
                        </a>
                      ) : (
                        <span>{name}</span>
                      )}
                      <span className="text-2xs text-fg-muted">{detail(i)}</span>
                      {i.noReceiptReason && !i.flags.some((f) => f.code === "no-receipt") && (
                        <span className="text-2xs text-fg-muted">{t("item.noReceiptWhy", { why: i.noReceiptReason })}</span>
                      )}
                      {i.flags.map((f) => (
                        <span key={`${f.code}-${f.text}`} className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs">
                          <Badge tone={f.blocks ? "danger" : f.finance ? "warning" : "neutral"}>{t(`flag.${f.code}`)}</Badge>
                          {f.text}
                        </span>
                      ))}
                    </span>
                  </span>
                </td>
                <td className="px-3 py-1.5 text-xs">
                  {i.category.name}
                  {i.category.account && <span className="block text-2xs text-fg-muted">{i.category.account}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-end font-mono text-xs">
                  {m(i.amount, i.currency)}
                  {i.currency !== "TRY" && (
                    <span className="block text-2xs text-fg-muted">
                      {i.rate.source === "pending"
                        ? t("item.ratePending")
                        : i.rate.source === "card"
                          ? t("item.rateCard", { amount: m(i.amountTry ?? 0) })
                          : i.rate.value
                            ? t("item.rateTcmb", { rate: i.rate.value })
                            : ""}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-end font-mono text-xs">
                  {i.kdv ? m(i.kdv) : "–"}
                  {i.vat.length > 0 && <span className="block text-2xs text-fg-muted">{i.vat.map((v) => pct(v.rate, locale)).join(", ")}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-end font-mono text-xs">
                  {i.paidBy === "company" ? t("item.paidByCard") : m(i.reimbursable)}
                  {i.held > 0 && <span className="block text-2xs text-warning-text">{t("item.held", { amount: m(i.held) })}</span>}
                </td>
                {(onEdit || onRemove) && (
                  <td className="px-3 py-1.5 text-end">
                    <span className="inline-flex gap-1">
                      {onEdit && (
                        <IconButton label={t("item.editOne", { name })} size="xs" onClick={() => onEdit(i)}>
                          <Pencil className="size-3.5" />
                        </IconButton>
                      )}
                      {onRemove && (
                        <IconButton label={t("item.removeOne", { name })} size="xs" onClick={() => onRemove(i)}>
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
          {!claim.lines.length && (
            <tr>
              <td colSpan={6} className="px-3 py-3 text-sm text-fg-muted">
                {t("claim.noItems")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function stepWho(s: { kind: Step["kind"]; approver: Step["approver"] }, t: T) {
  if (s.approver) return s.approver.name ?? s.approver.email;
  return t("claim.financeStep");
}

function Steps({ claim }: { claim: ClaimDetail }) {
  const t = useT();
  const [locale] = useLocalePreference();
  if (claim.state === "draft" && claim.plan.length)
    return (
      <ol aria-label={t("claim.whoApproves")} className="exp-list flex flex-col gap-1.5 text-xs">
        {claim.plan.map((s, i) => (
          <li key={`${s.approver?.email ?? "finance"}-${i}`} className="flex flex-col rounded-md border border-line px-2.5 py-1.5">
            <span className="font-medium text-fg">
              {i + 1}. {stepWho(s, t)}
            </span>
            <span className="text-2xs text-fg-muted">{s.why}</span>
            {s.approver && !s.approver.member && <span className="text-2xs text-warning-text">{t("claim.notMember", { email: s.approver.email })}</span>}
          </li>
        ))}
      </ol>
    );
  const steps = claim.steps.filter((s) => s.state !== "cancelled" || claim.state !== "draft");
  if (!steps.length) return <p className="m-0 text-xs text-fg-muted">{t("claim.noSteps")}</p>;
  return (
    <ol aria-label={t("claim.whoApproves")} className="exp-list flex flex-col gap-1.5 text-xs">
      {steps.map((s, i) => (
        <li
          key={s.id}
          className={`flex flex-col rounded-md border px-2.5 py-1.5 ${
            s.state === "approved" ? "border-success bg-success-soft" : s.state === "rejected" ? "border-danger bg-danger-soft" : "border-line"
          }`}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="font-medium text-fg">
              {i + 1}. {s.by && s.state !== "pending" && s.state !== "waiting" ? s.by.name : stepWho(s, t)}
            </span>
            <span className="text-fg-muted">
              {t(`step.${s.state}`)}
              {s.at ? `, ${when(s.at, locale)}` : ""}
            </span>
          </span>
          <span className="text-2xs text-fg-muted">{s.why}</span>
          {s.comment && <span className="text-2xs text-fg">“{s.comment}”</span>}
        </li>
      ))}
    </ol>
  );
}

type Decision = "approve" | "reject" | "return";

export function ClaimPage({ id, from, ...ctx }: Ctx & { id: string; from: ClaimPageId }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [claim, reload] = useLoad<ClaimDetail>(ctx.call, `/api/v1/claims/${encodeURIComponent(id)}`);
  const [adding, setAdding] = useState<ItemKind | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [comment, setComment] = useState("");
  const [passing, setPassing] = useState(false);
  const [to, setTo] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState<Note>(null);
  const back = `/${from}`;
  const crumb = t(from === "mine" ? "mine.title" : from === "approve" ? "approve.title" : "all.title");
  if (claim === undefined) return <PageHeader breadcrumbs={[{ label: crumb, href: back }]} title={t("loading")} />;
  if (claim === null) return <PageHeader breadcrumbs={[{ label: crumb, href: back }]} title={t("claim.notFound")} />;

  const done = (text: string) => (c?: ClaimDetail) => {
    setNote({ text });
    reload();
    ctx.onChanged();
    return c;
  };
  const failed = (err: Error) => setNote({ text: err.message, tone: "danger" });
  const act = (path: string, body: unknown, text: (c: ClaimDetail) => string) =>
    void ctx.call<ClaimDetail>(`/api/v1/claims/${claim.id}/${path}`, post(body)).then((c) => done(text(c))(c), failed);

  const owner = claim.owner.id === ctx.me.member.id;
  const draft = claim.state === "draft";
  const categories = new Map(ctx.policy.categories.map((c) => [c.id, c]));
  const kinds = new Set(ctx.policy.categories.map((c) => c.kind));
  const nextAfter = (c: ClaimDetail) => c.steps.find((s) => s.state === "pending");
  const sentText = (c: ClaimDetail) => {
    const [first, ...rest] = c.steps.filter((s) => s.state === "pending" || s.state === "waiting");
    if (!first) return t("claim.sentDone");
    return rest.length
      ? t("claim.sentThen", { first: stepWho(first, t), rest: rest.map((s) => stepWho(s, t)).join(", ") })
      : t("claim.sent", { first: stepWho(first, t) });
  };
  const decidedText = (d: Decision, c: ClaimDetail) => {
    if (d === "reject") return t("claim.rejected", { name: c.owner.name });
    if (d === "return") return t("claim.returned", { name: c.owner.name, why: comment.trim() });
    const next = nextAfter(c);
    if (next) return t("claim.approvedStep", { next: stepWho(next, t), name: c.owner.name });
    return c.state === "paid" ? t("claim.approvedCard") : t("claim.approvedAll", { amount: money(c.reimbursable, "TRY", locale) });
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: crumb, href: back }, { label: claim.number }]}
        title={claim.title}
        meta={<ClaimBadge state={claim.state} t={t} />}
        description={[
          claim.number,
          `${claim.owner.name}${claim.department ? `, ${claim.department.name}` : ""}`,
          claim.submittedAt ? t("claim.sentOn", { day: day(claim.submittedAt.slice(0, 10), locale) }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Button icon={<ArrowLeft />} onClick={() => navigate(back)}>
              {t("claim.back")}
            </Button>
            {claim.canEdit && (
              <>
                {kinds.has("receipt") && (
                  <Button icon={<Camera />} onClick={() => setAdding("receipt")}>
                    {t("claim.addReceipt")}
                  </Button>
                )}
                {kinds.has("mileage") && (
                  <Button icon={<Car />} onClick={() => setAdding("mileage")}>
                    {t("claim.addMileage")}
                  </Button>
                )}
                {kinds.has("per_diem") && (
                  <Button icon={<Plane />} onClick={() => setAdding("per_diem")}>
                    {t("claim.addDays")}
                  </Button>
                )}
                <Button
                  variant="primary"
                  icon={<Send />}
                  disabled={!claim.lines.length || claim.blocks.length > 0}
                  onClick={() => act("submit", undefined, sentText)}
                >
                  {t("claim.send")}
                </Button>
              </>
            )}
            {owner && claim.state === "submitted" && (
              <Button icon={<Undo2 />} onClick={() => act("withdraw", undefined, () => t("claim.withdrawn"))}>
                {t("claim.withdraw")}
              </Button>
            )}
            {claim.canDecide && (
              <>
                <Button icon={<Undo2 />} onClick={() => (setComment(""), setDeciding("return"))}>
                  {t("claim.sendBack")}
                </Button>
                <Button variant="danger" onClick={() => (setComment(""), setDeciding("reject"))}>
                  {t("claim.reject")}
                </Button>
                <Button variant="primary" onClick={() => act("approve", {}, (c) => decidedText("approve", c))}>
                  {t("claim.approve")}
                </Button>
              </>
            )}
            {can("editor") && claim.state === "submitted" && claim.pending && (
              <Button icon={<UserRoundCog />} onClick={() => (setTo(""), setComment(""), setPassing(true))}>
                {t("claim.pass")}
              </Button>
            )}
          </>
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {draft && claim.blocks.length > 0 && (
        <Callout tone="danger" title={t("claim.blocked")} className="mb-2.5">
          <ul className="exp-list">
            {claim.blocks.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Callout>
      )}
      <div className="exp-side grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <KpiGrid minWidth={150}>
            <KpiCard label={t("claim.spent")} value={money(claim.total, "TRY", locale)} unit={t("claim.itemsN", { count: claim.items })} />
            <KpiCard
              label={t("claims.paidBack")}
              value={money(claim.reimbursable, "TRY", locale)}
              unit={claim.companyPaid ? t("claim.byCard", { amount: money(claim.companyPaid, "TRY", locale) }) : undefined}
            />
            <KpiCard
              label={t("claims.flags")}
              value={String(claim.flags.count)}
              tone={claim.flags.blocking ? "danger" : claim.flags.finance ? "warning" : undefined}
              unit={claim.held ? t("claim.heldN", { amount: money(claim.held, "TRY", locale) }) : undefined}
            />
          </KpiGrid>
          <Panel title={t("claim.items")} aria-label={t("claim.items")} flush>
            <ItemsTable
              claim={claim}
              onEdit={claim.canEdit ? (i) => setEditing(i) : undefined}
              onRemove={
                claim.canEdit
                  ? (i) =>
                      void ctx
                        .call(`/api/v1/items/${i.id}`, { method: "DELETE" })
                        .then(() => done(t("item.removed", { name: i.seller ?? i.category.name }))(), failed)
                  : undefined
              }
            />
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("claim.whoApproves")} description={draft ? t("claim.whoApprovesDraft") : undefined} aria-label={t("claim.whoApproves")}>
            <Steps claim={claim} />
          </Panel>
          {claim.batch && (
            <Panel title={t("claim.payBack")}>
              <p className="m-0 text-xs text-fg">
                {t(claim.batch.method === "payroll" ? "claim.inPayroll" : "claim.inTransfer", {
                  number: claim.batch.number,
                  day: day(claim.batch.payDate, locale),
                })}
              </p>
            </Panel>
          )}
          {claim.canEdit && (
            <Panel title={t("claim.details")}>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" icon={<Pencil />} onClick={() => (setTitle(claim.title), setRenaming(true))}>
                  {t("claim.rename")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={() =>
                    void ctx.call(`/api/v1/claims/${claim.id}`, { method: "DELETE" }).then(() => {
                      ctx.onChanged();
                      navigate(back);
                    }, failed)
                  }
                >
                  {t("claim.delete")}
                </Button>
              </div>
            </Panel>
          )}
          <Panel title={t("claim.history")} aria-label={t("claim.history")}>
            <ol className="exp-list flex flex-col gap-1.5 text-xs">
              {[...claim.history].reverse().map((h, i) => (
                <li key={`${h.at}-${i}`} className="flex flex-col">
                  <span className="text-fg">
                    {HISTORY.includes(h.action) ? t(`history.${h.action.replace(" ", "-") as "created"}`, { name: h.by.name }) : `${h.by.name}: ${h.action}`}
                    <span className="text-fg-muted">, {when(h.at, locale)}</span>
                  </span>
                  {h.text && <span className="text-2xs text-fg-muted">{h.text}</span>}
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>

      {(adding || editing) && (
        <ItemDialog
          ctx={ctx}
          claim={claim}
          kind={editing?.kind ?? adding!}
          item={editing}
          categories={categories}
          onClose={() => {
            setAdding(null);
            setEditing(null);
          }}
          onSaved={(text) => {
            setAdding(null);
            setEditing(null);
            done(text)();
          }}
        />
      )}

      <Dialog
        open={deciding === "return" || deciding === "reject"}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={t(deciding === "reject" ? "claim.rejectTitle" : "claim.sendBackTitle", { number: claim.number, name: claim.owner.name })}
        description={t(deciding === "reject" ? "claim.rejectDetail" : "claim.sendBackDetail")}
        onSubmit={(e) => {
          e.preventDefault();
          const d = deciding!;
          setDeciding(null);
          act(d, { comment: comment.trim() }, (c) => decidedText(d, c));
        }}
        footer={
          <>
            <Button type="button" onClick={() => setDeciding(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant={deciding === "reject" ? "danger" : "primary"} disabled={!comment.trim()}>
              {t(deciding === "reject" ? "claim.reject" : "claim.sendBack")}
            </Button>
          </>
        }
      >
        <TextField
          label={t(deciding === "reject" ? "claim.why" : "claim.whatToChange")}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={deciding === "reject" ? undefined : t("claim.whatToChangeExample")}
        />
      </Dialog>

      <Dialog
        open={passing}
        onOpenChange={setPassing}
        title={t("claim.passTitle")}
        description={t("claim.passDetail", { step: claim.pending ? stepWho(claim.pending, t) : "" })}
        onSubmit={(e) => {
          e.preventDefault();
          setPassing(false);
          act("reassign", { to: to.trim(), ...(comment.trim() && { comment: comment.trim() }) }, () => t("claim.passed", { to: to.trim() }));
        }}
        footer={
          <>
            <Button type="button" onClick={() => setPassing(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!to.trim()}>
              {t("claim.pass")}
            </Button>
          </>
        }
      >
        <TextField label={t("claim.passTo")} type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
        <TextField label={t("claim.comment")} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Dialog>

      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t("claim.rename")}
        onSubmit={(e) => {
          e.preventDefault();
          setRenaming(false);
          void ctx.call<ClaimDetail>(`/api/v1/claims/${claim.id}`, patch({ title: title.trim() })).then(() => done(t("claim.renamed"))(), failed);
        }}
        footer={
          <>
            <Button type="button" onClick={() => setRenaming(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <TextField label={t("claims.title")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </Dialog>
    </>
  );
}
