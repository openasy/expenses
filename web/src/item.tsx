// Adding or changing one item of a draft claim: a receipt (photographed, read, then checked), a trip in your own car,
// or days away. The amounts the policy sets (per km, per day) are worked out by the server; the page shows its rates.
import { Button, Callout, Dialog, SelectField, TextField, useLocalePreference } from "@openasy/ui";
import { Camera, FileText, Receipt as ReceiptIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Ctx } from "./App.tsx";
import type { CardTransaction, Category, ClaimDetail, DocumentKind, Item, ItemInput, ItemKind, Receipt, ReadFields } from "./api.ts";
import { bytes, FileButton, money, moneyInput, Notice, parseMoney, parseNumber, patch, post, shortDay, today, useLoad, type Note, pct } from "./common.tsx";
import { useT } from "./i18n.ts";

/** Waits for the receipt reader, which reads in the background, for up to half a minute. */
async function waitForRead(ctx: Ctx, r: Receipt, live: () => boolean): Promise<Receipt> {
  let now = r;
  for (let i = 0; i < 20 && now.read.state === "pending" && live(); i++) {
    await new Promise((ok) => setTimeout(ok, 1500));
    now = await ctx.call<Receipt>(`/api/v1/receipts/${r.id}`);
  }
  return now;
}

interface Form {
  category: string;
  project: string;
  date: string;
  description: string;
  // receipts
  seller: string;
  sellerTaxNumber: string;
  amount: string;
  currency: string;
  /** "" keeps the category's rate (or what the receipt reads); "none" is no KDV; otherwise a rate. */
  kdv: string;
  document: DocumentKind | "";
  documentNumber: string;
  noReceiptReason: string;
  cardTransaction: string;
  // mileage and days away
  km: string;
  route: string;
  days: string;
  country: string;
}

function initial(kind: ItemKind, item: Item | null, categories: Category[]): Form {
  const first = categories.find((c) => c.kind === kind);
  return {
    category: item?.category.id ?? first?.id ?? "",
    project: item?.project?.id ?? "",
    date: item?.date ?? today(),
    description: item?.description ?? "",
    seller: item?.seller ?? "",
    sellerTaxNumber: item?.sellerTaxNumber ?? "",
    amount: item && kind === "receipt" ? moneyInput(item.amount, item.currency) : "",
    currency: item?.currency ?? "TRY",
    kdv: "",
    document: item && kind === "receipt" ? item.document : "",
    documentNumber: item?.documentNumber ?? "",
    noReceiptReason: item?.noReceiptReason ?? "",
    cardTransaction: item?.cardTransaction ?? "",
    km: item?.km !== null && item?.km !== undefined ? String(item.km) : "",
    route: item?.route ?? "",
    days: item?.days !== null && item?.days !== undefined ? String(item.days) : "1",
    country: item?.country ?? "TR",
  };
}

/** The fields a read receipt fills, as the form shows them. */
function fromRead(r: ReadFields): Partial<Form> {
  const currency = r.currency ?? "TRY";
  return {
    ...(r.date && { date: r.date }),
    ...(r.seller && { seller: r.seller }),
    ...(r.sellerTaxNumber && { sellerTaxNumber: r.sellerTaxNumber }),
    ...(r.documentNumber && { documentNumber: r.documentNumber }),
    ...(r.amount !== null && { amount: moneyInput(r.amount, currency), currency }),
  };
}

export function ItemDialog({
  ctx,
  claim,
  kind,
  item,
  categories,
  onClose,
  onSaved,
}: {
  ctx: Ctx;
  claim: ClaimDetail;
  kind: ItemKind;
  item: Item | null;
  categories: Map<string, Category>;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const own = [...categories.values()].filter((c) => c.kind === kind);
  const [f, setF] = useState<Form>(() => initial(kind, item, own));
  const set = (patchF: Partial<Form>) => setF((x) => ({ ...x, ...patchF }));
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [saving, setSaving] = useState(false);
  const [rate, setRate] = useState<string | null>(null);
  const [cards] = useLoad<{ transactions: CardTransaction[] }>(ctx.call, kind === "receipt" ? "/api/v1/cards/transactions?state=unmatched" : null);
  const cat = categories.get(f.category);
  const policy = ctx.policy;
  const hasFile = !!receipt || (!!item?.receipt && !receipt);
  const card = cards?.transactions.find((c) => c.id === f.cardTransaction);

  // The TCMB rate a receipt in another currency would get, to show before it is added.
  useEffect(() => {
    if (kind !== "receipt" || f.currency === "TRY" || f.cardTransaction || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || f.date > today()) {
      setRate(null);
      return;
    }
    let live = true;
    void ctx.call<{ rate: string; day: string }>(`/api/v1/rates?${new URLSearchParams({ currency: f.currency, date: f.date })}`).then(
      (r) => live && setRate(t("item.rateFor", { rate: r.rate, day: shortDay(r.day, locale) })),
      () => live && setRate(null),
    );
    return () => {
      live = false;
    };
  }, [ctx, kind, f.currency, f.date, f.cardTransaction, locale, t]);

  const upload = (file: File) => {
    setNote(null);
    setUploading(true);
    let live = true;
    void ctx
      .call<Receipt>("/api/v1/receipts", {
        method: "POST",
        body: file,
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
      })
      .then((r) => waitForRead(ctx, r, () => live))
      .then(
        (r) => {
          setReceipt(r);
          setUploading(false);
          // What was read fills the fields still empty; anything the person typed stays.
          if (r.read.state === "read" && r.read.fields) {
            const read = fromRead(r.read.fields);
            setF((x) => {
              const next = { ...x };
              for (const [k, v] of Object.entries(read) as Array<[keyof Form, string]>) {
                if (k === "currency" ? !x.amount : !x[k] || (k === "date" && x.date === today())) next[k] = v as never;
              }
              return next;
            });
          }
        },
        (err: Error) => {
          setUploading(false);
          setNote({ text: err.message, tone: "danger" });
        },
      );
    return () => {
      live = false;
    };
  };

  const body = (): ItemInput | string => {
    const b: ItemInput = { category: f.category, project: f.project || null, date: f.date, description: f.description.trim() || null };
    if (kind === "mileage") {
      const km = parseNumber(f.km);
      if (km === null) return t("item.kmInvalid");
      return { ...b, km: Math.round(km * 10) / 10, route: f.route.trim() || null };
    }
    if (kind === "per_diem") {
      const days = parseNumber(f.days);
      if (days === null || !Number.isInteger(days * 2)) return t("item.daysInvalid");
      return { ...b, days, country: f.country };
    }
    const r: ItemInput = {
      ...b,
      seller: f.seller.trim() || null,
      sellerTaxNumber: f.sellerTaxNumber.replace(/\s/g, "") || null,
      documentNumber: f.documentNumber.trim() || null,
      currency: f.currency,
      cardTransaction: f.cardTransaction || null,
    };
    if (f.amount.trim() || !f.cardTransaction) {
      const amount = parseMoney(f.amount, f.currency);
      if (amount === null) return t("item.amountInvalid");
      r.amount = amount;
    }
    if (f.document) r.document = f.document;
    if (f.kdv === "none") r.vat = [];
    else if (f.kdv) r.vat = [{ rate: Number(f.kdv) }];
    if (receipt) r.receipt = receipt.id;
    else if (!hasFile) r.noReceiptReason = f.noReceiptReason.trim() || null;
    // A field left as the receipt reads it is not sent, so the item keeps that it came from the receipt.
    const read = receipt?.read.state === "read" ? receipt.read.fields : null;
    if (read) {
      const same = fromRead(read);
      if (same.date === f.date) delete r.date;
      if (same.seller === f.seller.trim()) delete r.seller;
      if (same.sellerTaxNumber === r.sellerTaxNumber) delete r.sellerTaxNumber;
      if (same.documentNumber === r.documentNumber) delete r.documentNumber;
      if (same.amount === f.amount && same.currency === f.currency) {
        delete r.amount;
        delete r.currency;
      }
    }
    if (!item) return r;
    // Changing an item sends only what changed.
    const was: Record<string, unknown> = {
      category: item.category.id,
      project: item.project?.id ?? null,
      date: item.date,
      description: item.description,
      seller: item.seller,
      sellerTaxNumber: item.sellerTaxNumber,
      documentNumber: item.documentNumber,
      currency: item.currency,
      amount: item.amount,
      document: item.document,
      cardTransaction: item.cardTransaction,
      noReceiptReason: item.noReceiptReason,
      km: item.km,
      route: item.route,
      days: item.days,
      country: item.country,
    };
    const out = Object.fromEntries(Object.entries(r).filter(([k, v]) => k === "vat" || k === "receipt" || was[k] !== v)) as ItemInput;
    // A new amount or currency is sent with its pair, so the server reads them together.
    if (out.amount !== undefined || out.currency !== undefined) Object.assign(out, { amount: r.amount, currency: r.currency });
    return out;
  };

  const save = () => {
    const b = body();
    if (typeof b === "string") return setNote({ text: b, tone: "danger" });
    setNote(null);
    setSaving(true);
    const req = item ? ctx.call<Item>(`/api/v1/items/${item.id}`, patch(b)) : ctx.call<Item>(`/api/v1/claims/${claim.id}/items`, post(b));
    void req.then(
      (saved) => {
        setSaving(false);
        const name = saved.seller ?? saved.route ?? saved.category.name;
        onSaved(
          t(item ? "item.saved" : "item.added", {
            name,
            amount: money(saved.amountTry ?? saved.amount, saved.amountTry !== null ? "TRY" : saved.currency, locale),
          }),
        );
      },
      (err: Error) => {
        setSaving(false);
        setNote({ text: err.message, tone: "danger" });
      },
    );
  };

  const projectField = cat && cat.project !== "none" && ctx.projects.length > 0 && (
    <SelectField
      label={cat.project === "required" ? t("item.projectRequired") : t("item.project")}
      value={f.project}
      onChange={(e) => set({ project: e.target.value })}
      options={[
        ...(cat.project === "required" ? [] : [{ value: "", label: t("item.noProject") }]),
        ...ctx.projects.map((p) => ({ value: p.id, label: p.name })),
      ]}
      required={cat.project === "required"}
    />
  );
  const limitText = (c: Category) => {
    const l = c.limits.perItem ?? c.limits.perDay ?? c.limits.perMonth;
    if (l === null) return c.name;
    const per = c.limits.perItem !== null ? "item" : c.limits.perDay !== null ? "day" : "month";
    return t(`item.limit.${per}`, { name: c.name, amount: money(l, "TRY", locale) });
  };
  const perKm = cat?.perKm ?? null;
  const km = parseNumber(f.km);
  const perDay = cat?.perDay ?? null;
  const dayRate = perDay ? (perDay[f.country] ?? perDay.default) : undefined;
  const days = parseNumber(f.days);
  const countries = perDay ? Object.keys(perDay).filter((c) => c !== "default") : [];
  const read = receipt?.read;
  const title = t(item ? `item.edit.${kind}` : `item.add.${kind}`);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      size="lg"
      description={
        kind === "mileage" && perKm !== null
          ? t("item.mileageDetail", { rate: money(perKm, "TRY", locale) })
          : kind === "per_diem"
            ? t("item.daysDetail")
            : t("item.receiptDetail", {
                types: policy.receipts.types.map((x) => x.split("/").pop()!.toUpperCase()).join(", "),
                size: bytes(policy.receipts.maxSize, locale),
              })
      }
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={uploading}>
            {kind === "mileage" && km !== null && perKm !== null
              ? t("item.addAmount", { amount: money(Math.round((Math.round(km * 10) * perKm) / 10), "TRY", locale) })
              : item
                ? t("common.save")
                : t("item.addButton")}
          </Button>
        </>
      }
    >
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {kind === "receipt" && (
        <div className="flex items-center gap-3 rounded-md border border-line bg-canvas p-2.5">
          <span aria-hidden className="grid h-16 w-12 shrink-0 place-items-center rounded bg-subtle text-fg-muted">
            {receipt?.contentType === "application/pdf" || item?.receipt?.contentType === "application/pdf" ? (
              <FileText className="size-5" />
            ) : (
              <ReceiptIcon className="size-5" />
            )}
          </span>
          <span className="flex min-w-0 grow flex-col gap-0.5 text-sm">
            {receipt ? (
              <>
                <span className="truncate font-mono text-xs">
                  {receipt.filename}, {bytes(receipt.size, locale)}
                </span>
                {read?.state === "read" && read.fields ? (
                  <>
                    <span aria-label={t("item.whatWasRead")} className="text-fg">
                      {[
                        read.fields.seller,
                        read.fields.amount !== null ? money(read.fields.amount, read.fields.currency ?? "TRY", locale) : null,
                        read.fields.date ? shortDay(read.fields.date, locale) : null,
                        read.fields.vat.length ? `KDV ${read.fields.vat.map((v) => pct(v.rate, locale)).join(", ")}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="text-2xs text-fg-muted">
                      {read.fields.confidence !== null ? t("item.readConfidence", { percent: Math.round(read.fields.confidence * 100) }) : t("item.readCheck")}
                    </span>
                  </>
                ) : (
                  <span className="text-2xs text-fg-muted">
                    {read?.state === "pending"
                      ? t("item.reading")
                      : read?.state === "unclear"
                        ? t("item.readUnclear")
                        : read?.state === "failed"
                          ? t("item.readFailed")
                          : t("item.readNone")}
                  </span>
                )}
                {receipt.used.length > 0 && <span className="text-2xs text-warning-text">{t("item.usedBefore")}</span>}
              </>
            ) : item?.receipt ? (
              <span className="truncate font-mono text-xs">
                {item.receipt.filename}, {bytes(item.receipt.size, locale)}
              </span>
            ) : (
              <span className="text-xs text-fg-muted">{uploading ? t("item.uploading") : policy.receipts.read ? t("item.photoRead") : t("item.photo")}</span>
            )}
          </span>
          <FileButton
            label={hasFile ? t("item.otherFile") : t("item.pickFile")}
            accept={[...policy.receipts.types, ...(policy.receipts.types.includes("image/heic") ? [".heic"] : [])].join(",")}
            icon={<Camera />}
            onFile={(file) => void upload(file)}
            disabled={uploading}
            primary={!hasFile}
          />
        </div>
      )}
      <div className="exp-form2 grid gap-2.5">
        {own.length > 1 && (
          <SelectField
            label={t("item.category")}
            value={f.category}
            onChange={(e) => set({ category: e.target.value, ...(categories.get(e.target.value)?.project === "none" && { project: "" }) })}
            options={own.map((c) => ({ value: c.id, label: limitText(c) }))}
          />
        )}
        {projectField}
        <TextField label={t("item.date")} type="date" value={f.date} max={today()} onChange={(e) => set({ date: e.target.value })} required />
        {kind === "receipt" && cards && cards.transactions.length > 0 && (
          <SelectField
            label={t("item.card")}
            value={f.cardTransaction}
            onChange={(e) => {
              const tx = cards.transactions.find((x) => x.id === e.target.value);
              set({
                cardTransaction: e.target.value,
                ...(tx && {
                  date: tx.date,
                  currency: tx.currency ?? "TRY",
                  amount: moneyInput(tx.amount ?? tx.amountTry, tx.currency ?? "TRY"),
                  seller: f.seller || tx.description,
                }),
              });
            }}
            options={[
              { value: "", label: t("item.paidMyself") },
              ...cards.transactions.map((x) => ({
                value: x.id,
                label: `${shortDay(x.date, locale)} · ${x.description} · ${money(x.amountTry, "TRY", locale)}${x.card ? ` · •••• ${x.card}` : ""}`,
              })),
            ]}
          />
        )}
        {kind === "receipt" && (
          <>
            <TextField label={t("item.seller")} value={f.seller} onChange={(e) => set({ seller: e.target.value })} maxLength={120} />
            <div className="exp-amount grid items-end gap-1.5">
              <TextField
                label={t("item.total")}
                mono
                value={f.amount}
                onChange={(e) => set({ amount: e.target.value })}
                inputMode="decimal"
                hint={rate ?? (card ? t("item.cardCharged", { amount: money(card.amountTry, "TRY", locale) }) : undefined)}
                required={!f.cardTransaction}
              />
              <SelectField
                label={t("item.currency")}
                value={f.currency}
                onChange={(e) => set({ currency: e.target.value, ...(e.target.value !== "TRY" && { kdv: "" }) })}
                options={policy.currencies.map((c) => ({ value: c, label: c }))}
              />
            </div>
            <SelectField
              label={t("item.document")}
              value={f.document}
              onChange={(e) => set({ document: e.target.value as DocumentKind | "" })}
              options={[
                ...(item ? [] : [{ value: "", label: t("item.documentAuto") }]),
                { value: "invoice", label: t("document.invoice") },
                { value: "receipt", label: t("document.receipt") },
                { value: "other", label: t("document.other") },
                { value: "none", label: t("document.none") },
              ]}
            />
            {f.currency === "TRY" && f.document !== "other" && f.document !== "none" && (
              <SelectField
                label="KDV"
                value={f.kdv}
                onChange={(e) => set({ kdv: e.target.value })}
                options={[
                  {
                    value: "",
                    label: item
                      ? item.vat.length
                        ? t("item.kdvKeep", { rates: item.vat.map((v) => pct(v.rate, locale)).join(", ") })
                        : t("item.kdvNone")
                      : cat?.kdv
                        ? t("item.kdvCategory", { rate: pct(cat.kdv, locale) })
                        : t("item.kdvNone"),
                  },
                  ...policy.kdvRates.filter((r) => r > 0).map((r) => ({ value: String(r), label: pct(r, locale) })),
                  { value: "none", label: t("item.kdvNone") },
                ]}
              />
            )}
            <TextField
              label={t("item.documentNumber")}
              value={f.documentNumber}
              onChange={(e) => set({ documentNumber: e.target.value })}
              mono
              maxLength={60}
            />
            <TextField
              label={t("item.taxNumber")}
              value={f.sellerTaxNumber}
              onChange={(e) => set({ sellerTaxNumber: e.target.value })}
              mono
              inputMode="numeric"
              hint={t("item.taxNumberHint")}
            />
            {!hasFile && (
              <div className="exp-span2">
                <TextField
                  label={t("item.noReceiptReason")}
                  value={f.noReceiptReason}
                  onChange={(e) => set({ noReceiptReason: e.target.value })}
                  hint={t("item.noReceiptHint")}
                  maxLength={300}
                />
              </div>
            )}
          </>
        )}
        {kind === "mileage" && (
          <>
            <TextField
              label={t("item.km")}
              value={f.km}
              onChange={(e) => set({ km: e.target.value })}
              mono
              inputMode="decimal"
              adornment={<span className="text-xs text-fg-muted">km</span>}
              required
            />
            <TextField
              label={t("item.route")}
              value={f.route}
              onChange={(e) => set({ route: e.target.value })}
              placeholder={t("item.routeExample")}
              maxLength={300}
            />
          </>
        )}
        {kind === "per_diem" && (
          <>
            <SelectField
              label={t("item.country")}
              value={countries.includes(f.country) ? f.country : "other"}
              onChange={(e) => set({ country: e.target.value === "other" ? "" : e.target.value })}
              options={[
                ...countries.map((c) => ({
                  value: c,
                  label: t("item.countryRate", { country: countryName(c, locale), amount: money(perDay![c]!.amount, perDay![c]!.currency, locale) }),
                })),
                ...(perDay?.default
                  ? [{ value: "other", label: t("item.elsewhere", { amount: money(perDay.default.amount, perDay.default.currency, locale) }) }]
                  : []),
              ]}
            />
            {!countries.includes(f.country) && (
              <TextField
                label={t("item.countryCode")}
                value={f.country}
                onChange={(e) => set({ country: e.target.value.toUpperCase().slice(0, 2) })}
                mono
                placeholder="FR"
                hint={f.country.length === 2 ? countryName(f.country, locale) : undefined}
                required
              />
            )}
            <TextField
              label={t("item.days")}
              value={f.days}
              onChange={(e) => set({ days: e.target.value })}
              mono
              inputMode="decimal"
              hint={
                days !== null && dayRate
                  ? t("item.daysTotal", { amount: money(Math.round(dayRate.amount * days), dayRate.currency, locale) })
                  : t("item.daysHint")
              }
              required
            />
          </>
        )}
        <div className="exp-span2">
          <TextField
            label={t("item.description")}
            value={f.description}
            onChange={(e) => set({ description: e.target.value })}
            maxLength={500}
            placeholder={kind === "per_diem" ? t("item.daysExample") : undefined}
          />
        </div>
      </div>
      {cat && cat.limits.perItem === null && cat.limits.perDay === null && cat.limits.perMonth === null ? null : cat ? (
        <Callout tone="info" title={limitText(cat)} className="mt-2.5">
          {t(`item.over.${cat.overLimit}`)}
        </Callout>
      ) : null}
    </Dialog>
  );
}

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
