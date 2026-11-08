import { describe, expect, it } from "vitest";
import { decimalText, iban, kdvOf, minorDigits, parseDecimal, parseFileAmount, rateMicro, rateText, taxNumber, toKurus } from "./money.ts";

describe("money in whole numbers", () => {
  it("knows each currency's minor unit", () => {
    expect([minorDigits("TRY"), minorDigits("EUR"), minorDigits("JPY"), minorDigits("KWD")]).toEqual([2, 2, 0, 3]);
  });

  it("reads TCMB's rates per unit, as millionths of a lira", () => {
    expect(rateMicro("35.3961")).toBe(35_396_100);
    expect(rateMicro("27.8000", 100)).toBe(278_000);
    expect(rateMicro("0")).toBeNull();
    expect(rateMicro("1,5")).toBeNull();
    expect(rateText(35_396_100)).toBe("35.3961");
    expect(rateText(278_000, ",")).toBe("0,2780");
    expect(rateText(278_123)).toBe("0.278123");
  });

  it("converts to kuruş exactly, rounding half away from zero once", () => {
    expect(toKurus(12_345, "EUR", 48_500_000)).toBe(598_733); // 123.45 EUR x 48.5 = 5987.325 TL
    expect(toKurus(10_000, "JPY", 278_000)).toBe(278_000); // 10000 yen x 0.278 = 2780.00 TL
    expect(toKurus(1, "USD", 42_123_400)).toBe(42); // 0.01 USD = 0.421234 TL
    expect(toKurus(1_000, "KWD", 137_000_000)).toBe(13_700); // 1.000 KWD
  });

  it("works out the KDV a gross amount holds", () => {
    expect(kdvOf(64_000, 10)).toBe(5_818); // 640 TL at 10%: 58.18
    expect(kdvOf(120_000, 20)).toBe(20_000);
    expect(kdvOf(10_100, 1)).toBe(100);
    expect(kdvOf(5_000, 0)).toBe(0);
  });

  it("writes and reads decimals the ways people and banks write them", () => {
    expect(decimalText(123_456, "TRY", ",")).toBe("1234,56");
    expect(decimalText(5, "TRY")).toBe("0.05");
    expect(decimalText(-5, "TRY")).toBe("-0.05");
    expect(decimalText(1200, "JPY")).toBe("1200");
    expect(parseDecimal("1.234,56")).toBe(123_456);
    expect(parseDecimal("1,234.56")).toBe(123_456);
    expect(parseDecimal("640")).toBe(64_000);
    expect(parseDecimal("640,5")).toBe(64_050);
    expect(parseDecimal("1,234")).toBe(123_400);
    expect(parseDecimal("-82,30")).toBe(-8_230);
    expect(parseDecimal("(82.30)")).toBe(-8_230);
    expect(parseDecimal("12.345.678,90")).toBe(1_234_567_890);
    expect(parseDecimal("1.5", 0)).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
    expect(parseFileAmount("60 EUR")).toEqual({ amount: 6_000, currency: "EUR" });
    expect(parseFileAmount(8.5)).toEqual({ amount: 850, currency: "TRY" });
    expect(parseFileAmount("5.000 TL")).toEqual({ amount: 500_000, currency: "TRY" });
  });

  it("checks IBANs and Turkish tax numbers by their check digits", () => {
    expect(iban("TR33 0006 1005 1978 6457 8413 26")).toBe("TR330006100519786457841326");
    expect(iban("TR33 0006 1005 1978 6457 8413 27")).toBeNull();
    expect(iban("DE89 3704 0044 0532 0130 00")).toBe("DE89370400440532013000");
    expect(iban("TR33000610051978645784132")).toBeNull();
    expect(taxNumber("10000000146")).toBe("10000000146");
    expect(taxNumber("10000000147")).toBeNull();
    expect(taxNumber("1234567890")).toBe("1234567890");
    expect(taxNumber("1234567891")).toBeNull();
    expect(taxNumber("0010000001")).toBeNull();
    expect(taxNumber("4840847211")).toBe("4840847211");
  });
});
