// Spend: approved and paid-back spending by category, department, project, person or month, what the policy flagged,
// and KDV by rate. Exports: every item as CSV and the receipts as a ZIP, for the accountant.
import { Badge, BarList, DataTable, DonutChart, KpiCard, KpiGrid, PageHeader, Panel, SegmentedControl, SelectField, useLocalePreference } from "@openasy/ui";
import { FileDown } from "lucide-react";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { KdvReport, PolicyReport, Spend, SpendBy } from "./api.ts";
import { lastMonths, money, monthName, monthRange, num, shortDay, today, useLoad, pct } from "./common.tsx";
import { useT } from "./i18n.ts";

type Period = "month" | "year" | "last-year";

function periodRange(p: Period): { from: string; to: string } {
  const now = today();
  const y = Number(now.slice(0, 4));
  if (p === "month") return { from: `${now.slice(0, 7)}-01`, to: now };
  if (p === "year") return { from: `${y}-01-01`, to: now };
  return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
}

export function SpendPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [period, setPeriod] = useState<Period>("year");
  const [by, setBy] = useState<SpendBy>("category");
  const range = new URLSearchParams(periodRange(period));
  const [spend] = useLoad<Spend>(ctx.call, `/api/v1/reports/spend?${range}&by=${by}`);
  const [policy] = useLoad<PolicyReport>(ctx.call, `/api/v1/reports/policy?${range}`);
  const [kdv] = useLoad<KdvReport>(ctx.call, `/api/v1/reports/kdv?${range}`);
  const m = (n: number) => money(n, "TRY", locale);
  const f = ctx.summary?.finance;
  const rows = spend?.rows ?? [];
  const company = rows.reduce((n, r) => n + r.companyPaid, 0);
  const employees = rows.reduce((n, r) => n + r.reimbursable, 0);
  const label = (r: Spend["rows"][number]) => (by === "month" && r.key ? monthName(r.key, locale) : r.name);
  return (
    <>
      <PageHeader
        title={t("spend.title")}
        description={t("spend.description")}
        actions={
          <SegmentedControl
            label={t("spend.period")}
            value={period}
            onChange={setPeriod}
            options={[
              { value: "month", label: t("spend.thisMonth") },
              { value: "year", label: t("spend.thisYear") },
              { value: "last-year", label: t("spend.lastYear") },
            ]}
          />
        }
      />
      <KpiGrid minWidth={170} className="mb-2.5">
        <KpiCard
          label={t("spend.spent")}
          value={spend ? m(spend.total) : "–"}
          delta={{ label: t("spend.itemsN", { count: rows.reduce((n, r) => n + r.count, 0) }), intent: "neutral" }}
        />
        <KpiCard label={t("spend.waiting")} value={String(f?.waiting ?? 0)} delta={{ label: t("spend.waitingDetail"), intent: "neutral" }} href="/all" />
        <KpiCard
          label={t("spend.flagged")}
          value={policy ? String(policy.items.length) : "–"}
          tone={policy?.items.length ? "warning" : undefined}
          delta={{ label: t("spend.flaggedDetail"), intent: "neutral" }}
        />
        <KpiCard
          label={t("spend.unpaid")}
          value={m(f?.approvedTotal ?? 0)}
          delta={{ label: t("spend.unpaidDetail", { count: f?.approvedUnpaid ?? 0 }), intent: "neutral" }}
          href="/payback"
        />
      </KpiGrid>
      <div className="exp-side mb-2.5 grid gap-2.5">
        <Panel
          title={t(`spend.by.${by}`)}
          actions={
            <SegmentedControl
              label={t("spend.groupBy")}
              value={by}
              onChange={setBy}
              options={(["category", "department", "project", "person", "month"] as const).map((v) => ({ value: v, label: t(`spend.group.${v}`) }))}
            />
          }
        >
          {rows.length ? (
            <BarList label={t(`spend.by.${by}`)} items={rows.map((r, i) => ({ id: r.key ?? `none-${i}`, label: label(r), value: r.total }))} format={m} />
          ) : (
            <p className="m-0 text-sm text-fg-muted">{spend === undefined ? t("loading") : t("spend.nothing")}</p>
          )}
        </Panel>
        <Panel title={t("spend.paidBy")}>
          {company + employees > 0 ? (
            <DonutChart
              label={t("spend.paidBy")}
              slices={[
                { id: "employee", name: t("spend.employees"), value: employees },
                { id: "card", name: t("spend.cards"), value: company },
              ]}
              format={m}
            />
          ) : (
            <p className="m-0 text-sm text-fg-muted">{t("spend.nothing")}</p>
          )}
        </Panel>
      </div>
      <Panel title={t("spend.flags")} description={t("spend.flagsDetail")} flush className="mb-2.5">
        <DataTable
          label={t("spend.flags")}
          rows={policy?.items ?? []}
          loading={policy === undefined}
          empty={t("spend.noFlags")}
          getRowId={(r) => r.item.id}
          minWidth={760}
          pageSize={20}
          columns={[
            { id: "date", header: t("cards.date"), sortValue: (r) => r.item.date, cell: (r) => shortDay(r.item.date, locale) },
            {
              id: "claim",
              header: t("claims.claim"),
              cell: (r) => (
                <span className="flex flex-col">
                  <a href={`/all/${r.claim.id}`} className="font-mono text-xs">
                    {r.claim.number}
                  </a>
                  <span className="text-2xs text-fg-muted">{r.claim.owner.name}</span>
                </span>
              ),
            },
            {
              id: "item",
              header: t("claim.item"),
              cell: (r) => (
                <span className="flex flex-col text-xs">
                  {r.item.seller ?? r.item.category}
                  {r.flags.map((x) => (
                    <span key={`${x.code}-${x.text}`} className="flex flex-wrap items-center gap-1 text-2xs text-fg-muted">
                      <Badge tone={x.finance ? "warning" : "neutral"}>{t(`flag.${x.code}`)}</Badge>
                      {x.text}
                    </span>
                  ))}
                </span>
              ),
            },
            {
              id: "amount",
              header: t("claim.amount"),
              align: "right",
              mono: true,
              sortValue: (r) => r.item.amountTry ?? 0,
              cell: (r) => (r.item.amountTry !== null ? m(r.item.amountTry) : "–"),
            },
          ]}
        />
      </Panel>
      <Panel title="KDV" description={t("spend.kdvDetail")} flush>
        <DataTable
          label={t("spend.kdvByRate")}
          rows={kdv?.rates ?? []}
          loading={kdv === undefined}
          empty={t("spend.nothing")}
          getRowId={(r) => String(r.rate)}
          minWidth={560}
          columns={[
            { id: "rate", header: t("spend.rate"), cell: (r) => (r.rate ? pct(r.rate, locale) : t("spend.noKdv")) },
            { id: "base", header: t("spend.withoutKdv"), align: "right", mono: true, cell: (r) => m(r.base) },
            { id: "kdv", header: "KDV", align: "right", mono: true, cell: (r) => m(r.kdv) },
            { id: "count", header: t("spend.documents"), align: "right", mono: true, cell: (r) => num(r.count, locale) },
          ]}
        />
      </Panel>
    </>
  );
}

export function ExportsPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const months = lastMonths(13);
  const [month, setMonth] = useState(months[1] ?? months[0]!);
  const range = new URLSearchParams(monthRange(month));
  const e = ctx.settings?.config?.exports;
  const files = [
    { id: "items", name: `expenses-${month}.csv`, href: `/api/v1/exports/items?${range}`, text: t("exports.items") },
    { id: "receipts", name: `receipts-${month}.zip`, href: `/api/v1/exports/receipts?${range}`, text: t("exports.receipts") },
  ];
  return (
    <>
      <PageHeader
        title={t("exports.title")}
        description={
          e ? t("exports.description", { separator: e.separator === "\t" ? "Tab" : e.separator, decimal: e.decimal }) : t("exports.descriptionPlain")
        }
      />
      <div className="mb-2.5 w-56">
        <SelectField
          label={t("exports.month")}
          value={month}
          onChange={(ev) => setMonth(ev.target.value)}
          options={months.map((x) => ({ value: x, label: monthName(x, locale) }))}
        />
      </div>
      <div className="exp-halves grid gap-2.5">
        {files.map((f) => (
          <Panel
            key={f.id}
            title={f.name}
            aria-label={f.name}
            actions={
              <a
                href={f.href}
                download={f.name}
                aria-label={t("exports.download", { file: f.name })}
                className="inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-subtle hover:text-fg"
              >
                <FileDown aria-hidden className="size-3.5" />
              </a>
            }
          >
            <p className="m-0 text-sm text-fg">{f.text}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}
