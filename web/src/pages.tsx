// Integrations (HR, Time, the receipt reader, TCMB, and what Payroll and Time call) and the read-only settings file.
import { Callout, PageHeader, Panel, StatusBadge, useLocalePreference } from "@openasy/ui";
import type { ReactNode } from "react";
import type { Ctx } from "./App.tsx";
import type { Category, Integrations, LinkState, Settings } from "./api.ts";
import { bytes, Code, day, money, useLoad, when, pct } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT, type T } from "./i18n.ts";

type Link = LinkState;

function LinkPanel({ title, detail, link, example, children }: { title: string; detail: string; link: Link | null; example: string; children?: ReactNode }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const state = !link?.configured ? "off" : link.errorAt && (!link.okAt || link.errorAt > link.okAt) ? "failing" : link.okAt ? "ok" : "waiting";
  return (
    <Panel
      title={title}
      description={detail}
      actions={
        <StatusBadge tone={state === "ok" ? "success" : state === "failing" ? "danger" : state === "waiting" ? "warning" : "neutral"}>
          {t(`integrations.state.${state}`)}
        </StatusBadge>
      }
    >
      {!link?.configured ? (
        <Code label={title}>{example}</Code>
      ) : (
        <div className="flex flex-col gap-1 text-xs text-fg-muted">
          {link.url && <span className="font-mono text-fg">{link.url}</span>}
          {children}
          {link.okAt && <span>{t("integrations.okAt", { when: when(link.okAt, locale) })}</span>}
          {state === "failing" && link.error && <span className="text-danger-text">{link.error}</span>}
        </div>
      )}
    </Panel>
  );
}

export function IntegrationsPage(ctx: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [links] = useLoad<Integrations>(ctx.call, "/api/v1/integrations");
  const origin = window.location.origin;
  if (links === undefined) return <PageHeader title={t("integrations.title")} description={t("loading")} />;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="exp-halves grid gap-2.5">
        <LinkPanel
          title="HR"
          detail={t("integrations.hr")}
          link={links?.hr ?? null}
          example={`hr:
  url: http://hr:8080
  token: EXPENSES_HR_TOKEN   # an HR token with the viewer role
  every: 15m`}
        >
          {links && <span>{t("integrations.people", { count: links.hr.people })}</span>}
        </LinkPanel>
        <LinkPanel
          title="Time"
          detail={t("integrations.time")}
          link={links?.time ?? null}
          example={`time:
  url: http://time:8080
  token: EXPENSES_TIME_TOKEN
  every: 15m`}
        >
          {links && <span>{t("integrations.projects", { count: links.time.projects })}</span>}
        </LinkPanel>
        <LinkPanel
          title={t("integrations.reader")}
          detail={t("integrations.readerDetail")}
          link={links?.reader ?? null}
          example={`receipts:
  reader:
    url: http://receipt-reader:8080
    token: EXPENSES_READER_TOKEN
    min_confidence: 0.8`}
        >
          {links && links.reader.waiting > 0 && <span>{t("integrations.reading", { count: links.reader.waiting })}</span>}
        </LinkPanel>
        <LinkPanel title="TCMB" detail={t("integrations.tcmb")} link={links?.tcmb ?? null} example="">
          {links?.tcmb.lastDay && <span>{t("integrations.lastDay", { day: day(links.tcmb.lastDay, locale) })}</span>}
          {links && links.tcmb.pending > 0 && <span className="text-warning-text">{t("integrations.ratesPending", { count: links.tcmb.pending })}</span>}
        </LinkPanel>
        <Panel title="Payroll" description={t("integrations.payroll")}>
          <Code label="Payroll">{`GET ${origin}/api/v1/payroll?month=2026-11
POST ${origin}/api/v1/batches/{id}/paid
Authorization: Bearer <an Expenses token with the editor role>`}</Code>
        </Panel>
        <Panel title={t("integrations.projectCosts")} description={t("integrations.projectCostsDetail")}>
          <Code label={t("integrations.projectCosts")}>{`GET ${origin}/api/v1/project-costs?from=2026-01-01&to=2026-12-31
Authorization: Bearer <an Expenses token with the viewer role>`}</Code>
          <a href="/api/docs/" className="mt-2 block text-xs">
            {t("integrations.reference")}
          </a>
        </Panel>
      </div>
    </>
  );
}

function limitText(c: Category, t: T, locale: string): string {
  const parts = [
    c.limits.perItem !== null && t("settings.perItem", { amount: money(c.limits.perItem, "TRY", locale) }),
    c.limits.perDay !== null && t("settings.perDay", { amount: money(c.limits.perDay, "TRY", locale) }),
    c.limits.perMonth !== null && t("settings.perMonth", { amount: money(c.limits.perMonth, "TRY", locale) }),
  ].filter(Boolean);
  return `${parts.join(", ")}; ${t(`settings.over.${c.overLimit}`)}${c.project === "required" ? `; ${t("settings.needsProject")}` : ""}`;
}

function chainText(steps: Array<{ approver: string; over: number }>, t: T, locale: string): string {
  return steps
    .map((s) => {
      const who = s.approver === "manager" ? t("settings.manager") : s.approver === "finance" ? t("settings.finance") : s.approver;
      return s.over > 0 ? t("settings.overAmount", { who, amount: money(s.over, "TRY", locale) }) : who;
    })
    .join("; ");
}

export function SettingsFilePage({ settings }: Ctx & { settings: Settings }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const f = settings.file;
  const c = settings.config;
  const applied = f?.appliedAt ? when(f.appliedAt, locale) : t("settings.notYet");
  const limited = c?.categories.filter((x) => x.kind === "receipt" && (x.limits.perItem ?? x.limits.perDay ?? x.limits.perMonth) !== null) ?? [];
  const mileage = c?.categories.filter((x) => x.kind === "mileage") ?? [];
  const perDiem = c?.categories.filter((x) => x.kind === "per_diem") ?? [];
  const holders = c ? Object.keys(c.cards.holders).length : 0;
  return (
    <FileSettingsPage
      file="expenses.yaml"
      applied={applied}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        <>
          {f?.error && (
            <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
              {f.error}
            </Callout>
          )}
          {!!f?.warnings.length && (
            <Callout tone="warning" title={t("settings.warnings")} className="mb-2.5">
              <ul className="exp-list">
                {f.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      }
      groups={
        c
          ? [
              {
                title: t("settings.limits"),
                description: t("settings.limitsDetail"),
                items: limited.length
                  ? limited.map((x) => ({ label: x.name, value: limitText(x, t, locale), path: `categories.${x.id}.limit` }))
                  : [{ label: t("settings.categories"), value: t("settings.noLimits"), path: "categories" }],
              },
              {
                title: t("settings.rates"),
                items: [
                  ...mileage.map((x) => ({
                    label: x.name,
                    value: t("settings.perKm", { amount: money(x.perKm ?? 0, "TRY", locale) }),
                    path: `categories.${x.id}.rate`,
                  })),
                  ...perDiem.map((x) => ({
                    label: x.name,
                    value: Object.entries(x.perDay ?? {})
                      .map(([k, v]) => `${k === "default" ? t("settings.elsewhere") : k} ${money(v.amount, v.currency, locale)}`)
                      .join(", "),
                    path: `categories.${x.id}.rates`,
                  })),
                  {
                    label: t("settings.currencies"),
                    value: `${c.currencies?.join(", ") ?? t("settings.everyCurrency")}; ${t(`settings.rate.${c.rates.day === "same" ? "same" : "previous"}`)}`,
                    path: "rates",
                  },
                  { label: "KDV", value: c.kdvRates.map((r) => pct(r, locale)).join(", "), path: "kdv_rates" },
                ],
              },
              {
                title: t("settings.approvals"),
                description: t("settings.approvalsDetail"),
                items: [
                  { label: t("settings.everyone"), value: chainText(c.approvals.chain, t, locale), path: "approvals.chain" },
                  ...Object.entries(c.approvals.departments).map(([d, steps]) => ({
                    label: c.departments.find((x) => x.id === d)?.name ?? d,
                    value: chainText(steps, t, locale),
                    path: `approvals.departments.${d}`,
                  })),
                ],
              },
              {
                title: t("settings.receipts"),
                items: [
                  {
                    label: t("settings.files"),
                    value: `${c.receipts.types.map((x) => x.split("/").pop()!.toUpperCase()).join(", ")}, ${t("settings.upTo", { size: bytes(c.receipts.maxSize, locale) })}`,
                    path: "receipts.types",
                  },
                  {
                    label: t("settings.late"),
                    value: c.receipts.maxAgeDays ? t("settings.lateAfter", { days: c.receipts.maxAgeDays }) : t("settings.never"),
                    path: "receipts.max_age",
                  },
                  {
                    label: t("integrations.reader"),
                    value: c.receipts.reader ? t("settings.readerOn", { percent: Math.round(c.receipts.reader.minConfidence * 100) }) : t("settings.readerOff"),
                    path: "receipts.reader",
                  },
                ],
              },
              {
                title: t("settings.peopleCards"),
                items: [
                  {
                    label: t("settings.people"),
                    value: c.hr ? t("settings.fromHr", { minutes: c.hr.everyMinutes }) : t("settings.fromFile"),
                    path: c.hr ? "hr" : "people",
                  },
                  {
                    label: t("settings.projects"),
                    value: c.time ? t("settings.fromTime", { minutes: c.time.everyMinutes }) : t("settings.projectsFile"),
                    path: c.time ? "time" : "projects",
                  },
                  { label: t("settings.cards"), value: t("settings.cardsValue", { count: holders, days: c.cards.matchDays }), path: "cards" },
                  {
                    label: t("settings.exports"),
                    value: t("settings.exportsValue", { separator: c.exports.separator === "\t" ? "Tab" : c.exports.separator, decimal: c.exports.decimal }),
                    path: "exports",
                  },
                ],
              },
            ]
          : []
      }
    />
  );
}
