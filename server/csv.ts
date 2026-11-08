// CSV as spreadsheets write it (RFC 4180): quoted fields, quotes doubled inside them, line breaks in quotes, CRLF or LF.
// The separator is a comma, a semicolon as Excel writes it in Turkish and German, or a tab, chosen by the first lines.
// What Expenses writes for the accountant starts with a byte order mark, so Excel reads it as UTF-8.

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  // Banks put a few lines above the table, so the separator is the one the first lines use most.
  const sample = src.split(/\r?\n/, 20).join("\n");
  const counts = [",", ";", "\t"].map((c) => sample.split(c).length - 1);
  const sep = counts[1]! > counts[0]! && counts[1]! >= counts[2]! ? ";" : counts[2]! > counts[0]! ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** One CSV line. A cell that a spreadsheet would run as a formula (=, +, -, @, tab or return first, other than a
 * negative number) is written with a ' first. */
export function csvLine(cells: Array<string | number | null>, sep: string): string {
  return cells
    .map((c) => {
      if (c === null) return "";
      let s = String(c);
      if (typeof c === "string" && /^[=+\-@\t\r]/.test(s) && !/^-\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
      return s.includes(sep) || /["\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s;
    })
    .join(sep);
}

export const csvText = (rows: Array<Array<string | number | null>>, sep: string) => "\ufeff" + rows.map((r) => csvLine(r, sep)).join("\r\n") + "\r\n";

/** 2026-11-28, 28.11.2026, 28/11/2026 or 28.11.26: YYYY-MM-DD, or null. */
export function parseDay(raw: string): string | null {
  // Bank statements often add the time: 28.11.2026 14:05.
  const s = raw.trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?$/, "");
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/.exec(s)))
    [y, mo, d] = [m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1])];
  else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}
