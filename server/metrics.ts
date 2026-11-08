// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Claims by state. */
  claims: Record<string, number>;
  pendingSteps: number;
  ratesPending: number;
  receiptsReading: number;
  unmatchedCard: number;
  /** 1 when the last call to the link worked (or none was made), 0 when it failed. */
  links: Record<string, number>;
  counters: { receipts: Map<string, number>; decisions: Map<string, number>; syncs: Map<string, number> };
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="expenses",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_expenses_claims Claims, by state.",
    "# TYPE openasy_expenses_claims gauge",
    ...["draft", "submitted", "approved", "rejected", "paid"].map((s) => `openasy_expenses_claims{state="${s}"} ${g.claims[s] ?? 0}`),
    "# HELP openasy_expenses_pending_steps Approval steps waiting for someone.",
    "# TYPE openasy_expenses_pending_steps gauge",
    `openasy_expenses_pending_steps ${g.pendingSteps}`,
    "# HELP openasy_expenses_rates_pending Items waiting for their TCMB rate.",
    "# TYPE openasy_expenses_rates_pending gauge",
    `openasy_expenses_rates_pending ${g.ratesPending}`,
    "# HELP openasy_expenses_receipts_reading Receipts waiting for the reader.",
    "# TYPE openasy_expenses_receipts_reading gauge",
    `openasy_expenses_receipts_reading ${g.receiptsReading}`,
    "# HELP openasy_expenses_card_unmatched Company card purchases with no expense yet.",
    "# TYPE openasy_expenses_card_unmatched gauge",
    `openasy_expenses_card_unmatched ${g.unmatchedCard}`,
    "# HELP openasy_expenses_link_up 1 when the last call to HR, Time, the reader or TCMB worked.",
    "# TYPE openasy_expenses_link_up gauge",
    ...Object.entries(g.links).map(([k, v]) => `openasy_expenses_link_up{link="${k}"} ${v}`),
    "# HELP openasy_expenses_receipts_total Receipts uploaded and read, by result.",
    "# TYPE openasy_expenses_receipts_total counter",
    ...[...g.counters.receipts].map(([k, n]) => `openasy_expenses_receipts_total{result="${k}"} ${n}`),
    "# HELP openasy_expenses_decisions_total Approval decisions, by result.",
    "# TYPE openasy_expenses_decisions_total counter",
    ...[...g.counters.decisions].map(([k, n]) => `openasy_expenses_decisions_total{result="${k}"} ${n}`),
    "# HELP openasy_expenses_syncs_total Reads of HR's people and Time's projects, by result.",
    "# TYPE openasy_expenses_syncs_total counter",
    ...[...g.counters.syncs].map(([k, n]) => {
      const [link, result] = k.split(":");
      return `openasy_expenses_syncs_total{link="${link}",result="${result}"} ${n}`;
    }),
    "# HELP openasy_expenses_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_expenses_config_error gauge",
    `openasy_expenses_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
