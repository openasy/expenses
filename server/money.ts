// Money as whole numbers: every amount is kept in its currency's minor units (kuruş for TRY, cents for EUR, yen for
// JPY), and every sum is of whole numbers, so nothing rounds twice. Exchange rates are kept as millionths of a lira for
// one unit of the currency (TCMB gives four decimals, for 100 yen at a time). KDV is worked out from the gross amount
// on the receipt, as Turkish receipts print it.

/** The decimals a currency's minor unit has: 2 for TRY and EUR, 0 for JPY, 3 for KWD. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** True for a three-letter code Intl knows as a currency. */
export function knownCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return Intl.supportedValuesOf("currency").includes(code) || code === "XDR";
  } catch {
    return false;
  }
}

/** a * b / c, rounded half away from zero, on whole numbers. */
function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  const n = a * b;
  const neg = n < 0n !== c < 0n;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const q = (abs(n) * 2n + abs(c)) / (abs(c) * 2n);
  return neg ? -q : q;
}

/** An amount in a currency's minor units, in kuruş at a rate of rateMicro millionths of a lira per unit. */
export function toKurus(amountMinor: number, currency: string, rateMicro: number): number {
  const digits = minorDigits(currency);
  return Number(mulDiv(BigInt(amountMinor) * 100n, BigInt(rateMicro), 10n ** BigInt(digits) * 1_000_000n));
}

/** A decimal written with a dot ("35.3961") for `units` of the currency, as millionths of a lira per unit. */
export function rateMicro(decimal: string, units = 1): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(decimal.trim());
  if (!m || !Number.isInteger(units) || units < 1) return null;
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  const r = Number(mulDiv(micro, 1n, BigInt(units)));
  return r > 0 ? r : null;
}

/** The KDV a gross amount holds at a rate: gross * rate / (100 + rate), rounded to the kuruş. */
export function kdvOf(gross: number, ratePercent: number): number {
  // Rates such as 1, 10 and 20 are whole; a rate with decimals is kept to two places.
  const r = BigInt(Math.round(ratePercent * 100));
  return Number(mulDiv(BigInt(gross), r, 10_000n + r));
}

/** A share of an amount: amount * permille / 1000, rounded. */
export const share = (amount: number, num: number, den: number) => Number(mulDiv(BigInt(amount), BigInt(num), BigInt(den)));

/** Minor units as a decimal text with the separator given: 123456 TRY is 1234.56 or 1234,56. */
export function decimalText(amountMinor: number, currency: string, sep = "."): string {
  const digits = minorDigits(currency);
  const neg = amountMinor < 0;
  const s = String(Math.abs(amountMinor)).padStart(digits + 1, "0");
  const whole = digits ? s.slice(0, -digits) : s;
  const frac = digits ? s.slice(-digits) : "";
  return `${neg ? "-" : ""}${whole}${frac ? sep + frac : ""}`;
}

/** Millionths of a lira as a decimal text: 35396100 is 35.3961. */
export function rateText(micro: number, sep = "."): string {
  const s = String(micro).padStart(7, "0");
  return `${s.slice(0, -6)}${sep}${s.slice(-6).replace(/0{1,2}$/, "")}`;
}

/**
 * "5000", 5000, 5000.50, "5.000,50", "60 EUR": an amount in the file, in minor units of its currency (the file's
 * default when it names none), or null when it is not one.
 */
export function parseFileAmount(v: unknown, defaultCurrency = "TRY"): { amount: number; currency: string } | null {
  let raw = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  let currency = defaultCurrency;
  const cur = /\s*([A-Za-z]{3}|TL|₺)$/.exec(raw);
  if (cur) {
    const c = cur[1]!.toUpperCase();
    currency = c === "TL" || c === "₺" ? "TRY" : c;
    raw = raw.slice(0, cur.index).trim();
  }
  const amount = parseDecimal(raw, minorDigits(currency));
  return amount === null ? null : { amount, currency };
}

/** 45000, 45.000,00, 45,000.50, 45 000: minor units with the given decimals, or null. Negative amounts are kept. */
export function parseDecimal(raw: string, digits = 2): number | null {
  let s = raw.replace(/[\s ]/g, "");
  if (!s) return null;
  const neg = s.startsWith("-") || (s.startsWith("(") && s.endsWith(")"));
  s = s.replace(/^[-(]|\)$/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    s = s.replace(dec === "." ? /,/g : /\./g, "").replace(dec, ".");
  } else if (lastComma >= 0) {
    // 45,5 or 45,50 is a decimal comma; 45,000 is thousands.
    s = new RegExp(`^\\d+,\\d{1,${Math.max(digits, 2)}}$`).test(s) && !/^\d{1,3},\d{3}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot >= 0 && s.split(".").length > 2) s = s.replace(/\./g, "");
  else if (lastDot >= 0 && /^\d{1,3}\.\d{3}$/.test(s) && digits < 3) s = s.replace(".", "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > digits) return null;
  const n = BigInt(m[1]!) * 10n ** BigInt(digits) + BigInt((m[2] ?? "").padEnd(digits, "0") || "0");
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return neg ? -Number(n) : Number(n);
}

/** A Turkish or foreign IBAN, checked by its mod-97 digits; TR IBANs are 26 characters. Returns it grouped-free, upper case. */
export function iban(raw: string): string | null {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return null;
  if (s.startsWith("TR") && s.length !== 26) return null;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1 ? s : null;
}

/** A Turkish tax number: a VKN of 10 digits (its check digit verified) or a TCKN of 11 (both check digits verified). */
export function taxNumber(raw: string): string | null {
  const s = raw.replace(/\s/g, "");
  if (/^\d{10}$/.test(s)) {
    const d = [...s].map(Number);
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      const t = (d[i]! + 9 - i) % 10;
      let v = (t * 2 ** (9 - i)) % 9;
      if (t !== 0 && v === 0) v = 9;
      sum += v;
    }
    return (10 - (sum % 10)) % 10 === d[9] ? s : null;
  }
  if (/^[1-9]\d{10}$/.test(s)) {
    const d = [...s].map(Number);
    const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
    const even = d[1]! + d[3]! + d[5]! + d[7]!;
    if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return null;
    return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10] ? s : null;
  }
  return null;
}
