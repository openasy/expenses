// Fakes of TCMB's rate files, HR, Time and a receipt reader, on one local port, answering in the shapes Expenses reads.
// TCMB's files follow the layout of https://www.tcmb.gov.tr/kurlar/today.xml; HR's employees follow hr/openapi.json
// (Employee); Time has published no API yet, so its projects are the shape server/links.ts reads.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const HR_TOKEN = "hr-token-for-tests";
export const TIME_TOKEN = "time-token-for-tests";
export const READER_TOKEN = "reader-token-for-tests";

export interface FakeRate {
  unit?: number;
  forexBuying: string;
  forexSelling?: string;
  banknoteBuying?: string;
  banknoteSelling?: string;
}

/** A TCMB file for a day, YYYY-MM-DD. */
export function tcmbXml(day: string, rates: Record<string, FakeRate>): string {
  const [y, m, d] = day.split("-");
  const currencies = Object.entries(rates)
    .map(
      ([code, r]) => `  <Currency CrossOrder="0" Kod="${code}" CurrencyCode="${code}">
    <Unit>${r.unit ?? 1}</Unit>
    <Isim>${code}</Isim>
    <CurrencyName>${code}</CurrencyName>
    <ForexBuying>${r.forexBuying}</ForexBuying>
    <ForexSelling>${r.forexSelling ?? ""}</ForexSelling>
    <BanknoteBuying>${r.banknoteBuying ?? ""}</BanknoteBuying>
    <BanknoteSelling>${r.banknoteSelling ?? ""}</BanknoteSelling>
    <CrossRateUSD/>
    <CrossRateOther/>
  </Currency>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="isokur.xsl"?>
<Tarih_Date Tarih="${d}.${m}.${y}" Date="${m}/${d}/${y}" Bulten_No="${y}/1">
${currencies}
</Tarih_Date>
`;
}

export async function startFakes() {
  const state = {
    tcmb: { days: {} as Record<string, Record<string, FakeRate>>, status: 0, hits: [] as string[] },
    hr: { employees: [] as unknown[], status: 200, hits: [] as string[] },
    time: { projects: [] as unknown[], status: 200, hits: 0 },
    reader: { answer: {} as unknown, status: 200, hits: [] as Array<{ type: string; size: number }> },
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers.authorization;
    const reply = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const tcmb = /^\/tcmb\/(\d{4})(\d{2})\/(\d{2})(\d{2})(\d{4})\.xml$/.exec(url.pathname);
    if (tcmb) {
      const day = `${tcmb[5]}-${tcmb[4]}-${tcmb[3]}`;
      state.tcmb.hits.push(day);
      if (state.tcmb.status) return reply(state.tcmb.status, "down", "text/plain");
      const rates = state.tcmb.days[day];
      return rates ? reply(200, tcmbXml(day, rates), "application/xml") : reply(404, "<html>Not found</html>", "text/html");
    }
    if (url.pathname === "/hr/api/v1/employees") {
      state.hr.hits.push(url.search);
      if (auth !== `Bearer ${HR_TOKEN}`) return reply(401, { detail: "bad token" });
      if (state.hr.status !== 200) return reply(state.hr.status, { detail: "down" });
      return reply(200, { employees: state.hr.employees });
    }
    if (url.pathname === "/time/api/v1/projects") {
      state.time.hits++;
      if (auth !== `Bearer ${TIME_TOKEN}`) return reply(401, { detail: "bad token" });
      if (state.time.status !== 200) return reply(state.time.status, { detail: "down" });
      return reply(200, { projects: state.time.projects });
    }
    if (url.pathname === "/reader/read" && req.method === "POST") {
      if (auth !== `Bearer ${READER_TOKEN}`) return reply(401, { detail: "bad token" });
      let size = 0;
      req.on("data", (c: Buffer) => (size += c.length));
      req.on("end", () => {
        state.reader.hits.push({ type: String(req.headers["content-type"]), size });
        reply(state.reader.status, state.reader.status === 200 ? state.reader.answer : { detail: "cannot read" });
      });
      return;
    }
    reply(404, { detail: "no such fake" });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type Fakes = Awaited<ReturnType<typeof startFakes>>;
