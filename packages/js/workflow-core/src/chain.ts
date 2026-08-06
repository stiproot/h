/**
 * Chain shapes and stage arithmetic that both substrates need.
 *
 * A chain is ordered MEMBERS grouped into STAGES; each stage's members run concurrently and the
 * chain joins on all of them before advancing. That grouping rule — and the back-compat default
 * "absent stage ⇒ member index", i.e. one member per stage ⇒ sequential — is pure arithmetic over
 * the members array, and it must mean the same thing wherever a chain runs.
 *
 * What deliberately does NOT live here is the chain ENGINE (`chain-engine.ts`'s `decide`). That is
 * a per-tick state machine over a durable row — unknown-status streaks, wall-clock budgets, epoch
 * fences, orphan detection — and every one of those exists because the runs it sequences outlive
 * the process watching them. In-process there is no row and no tick: the driver awaits the stage.
 * Sharing the arithmetic and NOT the engine is the same split the substrates draw everywhere.
 */

/** The workflow KINDs a chain member can be — the selector for its coded threading contract. */
export const CHAIN_MEMBER_KINDS = ["implement-pr", "review-pr", "revise-pr", "answer"] as const;
export type ChainMemberKind = (typeof CHAIN_MEMBER_KINDS)[number];

/** All the stage helpers need of a member: its optional explicit stage. */
export type Staged = { readonly stage?: number };

/** A member's stage: explicit, else its index (back-compat — one member per stage = sequential). */
export function stageOf(members: readonly Staged[], index: number): number {
  return members[index]?.stage ?? index;
}

/** The distinct stage indices present, ascending. */
export function stagesOf(members: readonly Staged[]): number[] {
  const set = new Set<number>();
  for (let i = 0; i < members.length; i++) set.add(stageOf(members, i));
  return [...set].sort((a, b) => a - b);
}

/** The member indices in a stage, in member order. */
export function membersInStage(members: readonly Staged[], stage: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < members.length; i++) if (stageOf(members, i) === stage) out.push(i);
  return out;
}

/** The highest stage index (the last stage the chain finalizes on). */
export function lastStage(members: readonly Staged[]): number {
  return stagesOf(members).at(-1) ?? 0;
}

/**
 * Stage-shape validation shared by both substrates: stages must be 0-based, contiguous and
 * declared all-or-none, else a cursor+1 progression would skip a stage or stall, and the
 * `?? index` default would collide explicit and implicit stages. Returns an error message, or
 * null when valid.
 *
 * Carrier-specific rules (a saved key XOR inline steps; a cron member must be inline) stay with
 * the carrier — they are about how a member is FIRED, not how members group into stages.
 */
export function validateStages(members: readonly Staged[]): string | null {
  if (members.length === 0) return "chain has no members";
  const declared = members.filter((m) => m.stage !== undefined).length;
  if (declared !== 0 && declared !== members.length)
    return "either all members declare a stage or none do";
  const stages = stagesOf(members);
  for (let s = 0; s < stages.length; s++)
    if (stages[s] !== s) return `stages must be contiguous from 0 (got ${stages.join(",")})`;
  return null;
}
