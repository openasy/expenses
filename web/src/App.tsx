import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  ChartPie,
  CheckCheck,
  CreditCard,
  FileDown,
  Inbox,
  KeyRound,
  LogIn,
  LogOut,
  Plug,
  Receipt,
  Settings as SettingsIcon,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Claim, Me, Policy, ProductLink, Ref, Settings, Summary } from "./api.ts";
import { CardsPage } from "./cards.tsx";
import { AllPage, ApprovePage, ClaimPage, MinePage, type ClaimPageId } from "./claims.tsx";
import { useApi, type Call } from "./common.tsx";
import { useT, setViewerLocale } from "./i18n.ts";
import { IntegrationsPage, SettingsFilePage } from "./pages.tsx";
import { PayBackPage } from "./payback.tsx";
import { ExportsPage, SpendPage } from "./reports.tsx";

const PAGES = ["mine", "approve", "all", "cards", "payback", "spend", "exports", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page } | { page: "claim"; id: string; from: ClaimPageId };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES];
/** Pages for viewers and above: finance, and whoever reads the numbers. */
const FINANCE: readonly Page[] = ["all", "payback", "spend", "exports", "integrations", "settings"];

function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if ((page === "mine" || page === "approve" || page === "all") && id) return { page: "claim", id: decodeURIComponent(id), from: page };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "mine" };
}

export interface Ctx {
  call: Call;
  me: Me;
  policy: Policy;
  projects: Ref[];
  summary: Summary | undefined;
  /** The settings file as applied: for viewers and above only. */
  settings: Settings | null;
  /** Counts in the menu may have changed. */
  onChanged: () => void;
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me: auth, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [me, setMe] = useState<Me>();
  const [policy, setPolicy] = useState<Policy>();
  const [projects, setProjects] = useState<Ref[]>([]);
  const [summary, setSummary] = useState<Summary>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const finance = can("viewer");

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "expenses" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Me>("/api/v1/me").then(setMe, () => {});
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<Policy>("/api/v1/policy").then(setPolicy, () => {});
    void call<{ projects: Ref[] }>("/api/v1/projects").then(
      (r) => setProjects(r.projects),
      () => {},
    );
    if (finance) void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call, finance]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds claims by title, number or person: everyone's for finance, your own otherwise.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const scope = finance ? "all" : "mine";
      const r = await call<{ claims: Claim[] }>(`/api/v1/claims?${new URLSearchParams({ scope, q })}`, { signal });
      return r.claims.slice(0, 8).map((c) => ({
        id: c.id,
        label: c.title,
        detail: `${c.number}, ${c.owner.name}`,
        kind: msg("search.claim"),
        icon: Receipt,
        href: `/${c.owner.id === auth.user.id ? "mine" : scope}/${c.id}`,
      }));
    },
    [call, msg, finance, auth.user.id],
  );

  const f = summary?.finance;
  const nav = [
    { id: "mine", label: msg("nav.mine"), icon: Receipt, count: summary?.drafts || undefined },
    { id: "approve", label: msg("nav.approve"), icon: Inbox, count: summary?.toApprove || undefined },
    ...(finance ? [{ id: "all", label: msg("nav.all"), icon: CheckCheck, count: f?.waiting || undefined }] : []),
    { id: "cards", label: msg("nav.cards"), icon: CreditCard, count: (finance ? f?.unmatchedCard : summary?.unmatchedCard) || undefined },
    ...(finance
      ? [
          { id: "payback", label: msg("nav.payback"), icon: Wallet, count: f?.approvedUnpaid || undefined },
          { id: "spend", label: msg("nav.spend"), icon: ChartPie },
          { id: "exports", label: msg("nav.exports"), icon: FileDown },
        ]
      : []),
  ];
  const footerNav = [
    ...(finance
      ? [
          { id: "integrations", label: msg("nav.integrations"), icon: Plug },
          { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
        ]
      : []),
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "claim" ? route.from : route.page;
  const roleName = msg(`roles.${(["owner", "admin", "editor", "viewer", "user"].includes(auth.user.role) ? auth.user.role : "user") as "user"}`);
  const ctx = me && policy && { call, me, policy, projects, summary, settings, onChanged: reload };
  const financeOnly = route.page !== "claim" && FINANCE.includes(route.page) && !finance;

  return (
    <AppShell
      product="expenses"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: auth.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {settings.file.error}
        </Callout>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : financeOnly ? (
        <EmptyState title={msg("auth.financeOnly")}>{msg("auth.financeOnlyDetail")}</EmptyState>
      ) : !ctx ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "claim" ? (
        <ClaimPage key={route.id} {...ctx} id={route.id} from={route.from} />
      ) : route.page === "approve" ? (
        <ApprovePage {...ctx} />
      ) : route.page === "all" ? (
        <AllPage {...ctx} />
      ) : route.page === "cards" ? (
        <CardsPage {...ctx} />
      ) : route.page === "payback" ? (
        <PayBackPage {...ctx} />
      ) : route.page === "spend" ? (
        <SpendPage {...ctx} />
      ) : route.page === "exports" ? (
        <ExportsPage {...ctx} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage {...ctx} />
      ) : route.page === "settings" ? (
        ctx.settings ? (
          <SettingsFilePage {...ctx} settings={ctx.settings} />
        ) : (
          <PageHeader title={msg("loading")} />
        )
      ) : (
        <MinePage {...ctx} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Expenses">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
