// Who approves a claim, from the file's chain for the person's department (or the general one) and the claim's total:
//
// - A step applies when the total is over its `over` (0: always).
// - manager is the person's manager from HR (or the file). Without a manager, the step goes to finance.
// - Nobody approves their own claim: a step that would land on the claimant goes to finance instead.
// - The same person approves once: a step whose approver already approved an earlier step is left out.
// - A claim with something the policy flags for finance (over a limit, no receipt, a duplicate, late) gets a finance
//   step at the end when the chain has none.
// - A finance step is taken by any member with the editor role or above, other than the claimant and the members who
//   approved earlier steps of the same round, so one person never approves a claim twice.
import type { Config } from "./config.ts";
import { decimalText } from "./money.ts";

export interface PlannedStep {
  kind: "manager" | "finance" | "member";
  /** null for finance. */
  approver: string | null;
  why: string;
}

export function planChain(
  c: Config,
  claim: { ownerEmail: string; department: string | null; total: number },
  manager: string | null,
  financeReasons: string[],
): PlannedStep[] {
  const steps = (claim.department && c.approvals.departments[claim.department]) || c.approvals.chain;
  const plan: PlannedStep[] = [];
  const over = (n: number) => (n > 0 ? ` (over ${decimalText(n, "TRY")} TRY)` : "");
  for (const s of steps) {
    if (claim.total <= s.over && s.over > 0) continue;
    if (s.approver === "manager") {
      if (!manager) plan.push({ kind: "finance", approver: null, why: "No manager is known for the claimant." });
      else if (manager === claim.ownerEmail) plan.push({ kind: "finance", approver: null, why: "The manager is the claimant." });
      else plan.push({ kind: "manager", approver: manager, why: `Their manager${over(s.over)}.` });
    } else if (s.approver === "finance") plan.push({ kind: "finance", approver: null, why: `Finance${over(s.over)}.` });
    else if (s.approver === claim.ownerEmail) plan.push({ kind: "finance", approver: null, why: `${s.approver} is the claimant.` });
    else plan.push({ kind: "member", approver: s.approver, why: `The file names ${s.approver}${over(s.over)}.` });
  }
  if (financeReasons.length && !plan.some((p) => p.kind === "finance"))
    plan.push({ kind: "finance", approver: null, why: `The policy asks finance: ${financeReasons.join("; ")}.` });
  // One step per person, and one finance step: the first one stays.
  const seen = new Set<string>();
  const out = plan.filter((p) => {
    const k = p.approver ?? "finance";
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out.length ? out : [{ kind: "finance", approver: null, why: "Finance." }];
}
