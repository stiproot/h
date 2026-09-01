import { AGENT_STRATEGIES } from "agent-cli";
import { Effect } from "effect";

import { LOCAL_AGENT_TYPES, type ProbeEnvelope, type ProbeJob } from "./models.ts";

/**
 * Answer "could each agent actually run from here?" — the question `h doctor` needs and could not
 * ask.
 *
 * Doctor used to report an agent as `ok` when its binary resolved on PATH. A binary is not an
 * agent that can run: on 2026-09-01 a two-agent review lost codex at run time because nothing set
 * `CODEX_AUTH_MODE=chatgpt`, having been told `codex ok` moments earlier. The credentials were
 * present the whole time; one variable was not.
 *
 * The authority already exists. Every strategy's `validateEnvironment` states that agent's auth
 * requirement WITH its either/or logic — API key vs subscription token vs enterprise access token —
 * and `AGENT_STRATEGIES` is exported precisely so a caller can ask without invoking. So the probe
 * asks it rather than paraphrasing the keys, the same rule `check-env-local` follows: a restated
 * list is a list that drifts, and here it would drift into confidently wrong readiness.
 *
 * It lives in the RUNNER rather than in the Python CLI for the reason the registry codec does: a
 * second implementation of these rules would drift, and its symptom would be a doctor that
 * disagrees with the run it is supposed to predict.
 *
 * `{}` for the effective env and the ambient `process.env` is not an approximation — it is exactly
 * what a `--local` run passes (`agent-cli-agent.ts` sends `env: {}` and no llmConfig ON PURPOSE, so
 * a run uses the operator's own authenticated CLIs). The probe therefore returns the answer the
 * run will give, not a generic one.
 */
export const runProbe = (job: ProbeJob): Effect.Effect<ProbeEnvelope> =>
  Effect.sync(() => ({
    ok: true,
    op: job.op,
    agents: LOCAL_AGENT_TYPES.map((agent) => {
      const strategy = AGENT_STRATEGIES[agent];
      const problem = strategy.validateEnvironment({}, process.env);
      return {
        agent,
        ready: problem === null,
        // The strategy's own words. `stderr` is the terse form ("Missing OPENAI_API_KEY or
        // CODEX_AUTH_MODE=chatgpt"); it names the variables, which is the whole actionable payload.
        detail: problem === null ? null : (problem.stderr ?? "").trim() || "unavailable",
      };
    }),
  }));
