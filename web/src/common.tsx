// What the pages share: data loading with the session, formatting money and days, and the state a claim is shown in.
import { useAuth } from "@openasy/auth/react";
import { StatusBadge, type Tone } from "@openasy/ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type BatchState, type ClaimState } from "./api.ts";
import type { T } from "./i18n.ts";
import { viewerLocale } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  return [data, () => setN((x) => x + 1)] as const;
}

export const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });
export const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
export const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`mb-2.5 rounded-md px-3 py-2 text-sm text-fg ${tone === "danger" ? "bg-danger-soft" : "bg-success-soft"}`}
    >
      {children}
    </div>
  );
}

export type Note = { text: string; tone?: "danger" } | null;

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="exp-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

// ---------------------------------------------------------------- formatting

/** The decimals a currency's minor unit has: 2 for TRY and EUR, 0 for JPY, 3 for KWD. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** 64000 kuruş is "640.00 TL" in English and "640,00 TL" in Turkish; TRY is written TL, as people write it. */
export function money(minor: number, currency = "TRY", locale: string = viewerLocale()) {
  const d = minorDigits(currency);
  const v = new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(minor / 10 ** d);
  return `${v} ${currency === "TRY" ? "TL" : currency}`;
}

/** An amount as typed in a field: "2400", "2.400,50", "2,400.50" or "2400.5"; null when it is not one. */
export function parseMoney(raw: string, currency = "TRY"): number | null {
  const d = minorDigits(currency);
  let s = raw.replace(/\s|TL|TRY|₺/gi, "").replace(new RegExp(currency, "i"), "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const frac = new RegExp(`[.,]\\d{1,${Math.max(d, 1)}}$`);
  const dec = d === 0 ? null : lastComma > lastDot ? (frac.test(s) ? "," : null) : lastDot > lastComma ? (frac.test(s) ? "." : null) : null;
  s = dec === "," ? s.replace(/\./g, "").replace(",", ".") : dec === "." ? s.replace(/,/g, "") : s.replace(/[.,]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  if (f.length > d) return null;
  return Number(w) * 10 ** d + Number(f.padEnd(d, "0") || 0);
}

/** Minor units as a field shows them to be changed: 64000 is "640", 64050 is "640.50" or "640,50". */
export function moneyInput(minor: number, currency = "TRY", locale: string = viewerLocale()) {
  const d = minorDigits(currency);
  const whole = Math.trunc(minor / 10 ** d);
  const frac = Math.abs(minor % 10 ** d);
  if (!frac) return String(whole);
  const sep = new Intl.NumberFormat(locale).format(1.5).includes(",") ? "," : ".";
  return `${whole}${sep}${String(frac).padStart(d, "0")}`;
}

/** A number as typed: "1,5" or "1.5"; null when it is not one above 0. */
export function parseNumber(raw: string): number | null {
  const n = Number(raw.trim().replace(",", "."));
  return raw.trim() && Number.isFinite(n) && n > 0 ? n : null;
}

export const num = (n: number, locale: string = viewerLocale(), digits = 2) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);

/** A rate in percent as the language writes it: 20% in English, %20 in Turkish, 20 % in German. */
export const pct = (n: number, locale: string = viewerLocale()) =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(n / 100);

export const day = (d: string, locale: string = viewerLocale()) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const shortDay = (d: string, locale: string = viewerLocale()) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
export const monthName = (m: string, locale: string = viewerLocale()) =>
  new Date(`${m}-15T12:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
export const when = (iso: string, locale: string = viewerLocale()) =>
  new Date(iso).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Today as YYYY-MM-DD in the browser's zone. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The first and last day of a month, YYYY-MM. */
export function monthRange(m: string): { from: string; to: string } {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, "0")}` };
}

/** The last n months, newest first, as YYYY-MM. */
export function lastMonths(n: number, from = today()): string[] {
  const [y, m] = from.split("-").map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 15));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export const bytes = (n: number, locale: string = viewerLocale()) =>
  n >= 1024 * 1024 ? `${num(n / 1024 / 1024, locale, 1)} MB` : `${num(Math.max(1, Math.round(n / 1024)), locale, 0)} KB`;

// ---------------------------------------------------------------- claims

export const CLAIM_TONE: Record<ClaimState, Tone> = {
  draft: "neutral",
  submitted: "warning",
  approved: "success",
  rejected: "danger",
  paid: "info",
};

export function ClaimBadge({ state, t }: { state: ClaimState; t: T }) {
  return <StatusBadge tone={CLAIM_TONE[state]}>{t(`state.${state}`)}</StatusBadge>;
}

export const BATCH_TONE: Record<BatchState, Tone> = { open: "neutral", sent: "info", paid: "success" };

/** A file input styled as a button. */
export function FileButton({
  label,
  accept,
  onFile,
  icon,
  disabled,
  primary,
}: {
  label: string;
  accept: string;
  onFile: (f: File) => void;
  icon: ReactNode;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <label
      className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 ${
        primary
          ? "border-accent bg-accent text-accent-contrast hover:border-accent-hover hover:bg-accent-hover"
          : "border-line-strong bg-surface text-fg hover:bg-subtle"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <span aria-hidden className="exp-icon">
        {icon}
      </span>
      {label}
      <input
        type="file"
        accept={accept}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}
