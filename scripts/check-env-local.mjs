#!/usr/bin/env node
// Headless host-mode env preflight — fail LOUDLY, listing EVERY missing key at once, before a
// single service is launched.
//
// The pain this removes: a bring-up used to die one key at a time, deep inside whichever run
// script happened to start first (`ANTHROPIC_BASE_URL: unbound variable`), or — worse — come up
// green and only fail when an agent was finally invoked and its CLI had no credentials.
//
// NOTHING here is a hand-maintained list of keys; a restated list is a list that drifts. Both
// requirement sources are DERIVED from the artifacts that already own the truth:
//
//   1. HARD-REQUIRED shell keys — every run-*.sh sets `set -u`, so a `${VAR}` reference with no
//      `:-` default and no earlier local assignment aborts the script. Scanning for exactly that
//      shape finds today's and finds new ones the day someone writes one.
//   2. AGENT AUTH — a strategy's own `validateEnvironment` IS the statement of what that agent
//      needs (API key vs subscription token vs ChatGPT auth mode, with all the either/or logic).
//      We ask it, via agent-cli's AGENT_STRATEGIES, instead of paraphrasing it.
//
// Service membership comes from cli/scripts/_services.sh — the same source up-host.sh, wait-host.sh
// and down-host.sh read, so a mode's set is never restated either.
//
// This is an OPS preflight, not a lint guard: its answer depends on the operator's own .env, so it
// is deliberately NOT in `bun run lint`. It runs from up-host.sh and `make check-env-local`.
//
// Usage: node scripts/check-env-local.mjs [--mode dev|h-builds-h] [--strict]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = resolve(root, "cli/scripts");

// Names a run script gets from the shell/OS or bash itself, never from .env.
const AMBIENT = new Set([
  "HOME",
  "PATH",
  "USER",
  "PWD",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
  "BASH_SOURCE",
  "FUNCNAME",
  "PIPESTATUS",
  "IFS",
  "OSTYPE",
  "HOSTNAME",
  "RANDOM",
]);

/** Parse KEY=VALUE env-file text the way `set -a; source .env` would see it. */
export function parseEnvText(contents) {
  const out = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * The env a run script will actually see, in the two senses the two checks need.
 *
 * `.env` WINS over an exported shell value because the run scripts do `set -a; source .env` — an
 * unconditional assignment. (Deliberately the opposite of the local substrate's `h delegate`, where
 * the shell wins; do not "fix" one to match the other.)
 *
 * DECLARED vs USABLE is a real distinction here, not pedantry: `set -u` is satisfied by a bare
 * `FOO=` line — the variable exists, so `${FOO}` expands to "" and the script runs — while an agent
 * CLI handed an empty API key is simply unauthenticated. So the unbound-variable check reads
 * `declared` and the auth check reads `usable`.
 */
export function mergeEnv(processEnv, fileEnv) {
  const declared = new Set([...Object.keys(processEnv), ...Object.keys(fileEnv)]);
  const usable = { ...processEnv };
  for (const [key, value] of Object.entries(fileEnv)) {
    if (value !== "") usable[key] = value;
    else delete usable[key]; // `.env` assigning empty OVERWRITES an exported value — with nothing.
  }
  return { declared, usable };
}

/**
 * Keys a `set -u` script body references with no default — an unset one aborts it with
 * "unbound variable" before anything starts.
 */
export function hardRequiredKeysIn(body) {
  if (!/set -[a-z]*u/.test(body)) return [];

  const required = new Set();
  const assignedBefore = new Set();
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    for (const match of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(.?)/g)) {
      const [, key, next] = match;
      // `${VAR:-x}` / `${VAR:?x}` / `${VAR:+x}` / `${VAR#…}` all have a fallback or are safe;
      // only a bare `${VAR}` is fatal under set -u.
      if (next !== "}") continue;
      if (AMBIENT.has(key) || assignedBefore.has(key)) continue;
      required.add(key);
    }
    // Recorded AFTER the scan: an assignment later on the same line doesn't save the reference.
    const assignment = line.match(/^\s*(?:export\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (assignment) assignedBefore.add(assignment[1]);
  }
  return [...required];
}

/** `run-codex-agent.sh` → `codex`, else null. */
export function agentTypeOf(service) {
  return service.match(/^run-([a-z0-9]+)-agent\.sh$/)?.[1] ?? null;
}

/**
 * Collect every problem for a mode.
 *
 * Two severities, because the two failures are genuinely different: a missing hard-required key
 * ABORTS the run script so the stack never comes up, while missing agent auth lets the service
 * start healthy and only fails once a run is dispatched to it. Blocking a whole dev bring-up
 * because one agent has no key would be wrong — telling you before you burn a run is the point.
 */
export function collectProblems({ services, readScript, declared, usable, strategies }) {
  const errors = [];
  const warnings = [];

  for (const service of services) {
    const body = readScript(service);
    if (body === null) continue;
    for (const key of hardRequiredKeysIn(body)) {
      if (!declared.has(key)) {
        errors.push({ key, why: `${service} references \${${key}} with no default (set -u)` });
      }
    }
  }

  if (strategies) {
    for (const service of services) {
      const agent = agentTypeOf(service);
      const strategy = agent ? strategies[agent] : null;
      if (!strategy) continue;
      const failure = strategy.validateEnvironment({}, usable);
      if (failure) {
        const message = failure.stdout ?? failure.stderr ?? String(failure);
        warnings.push({
          key: `${agent} auth`,
          why: `${message} (${service} will start; its runs will fail)`,
        });
      }
    }
  }

  return { errors, warnings };
}

/** The run scripts a mode launches, straight from _services.sh. */
function servicesFor(modeName) {
  const out = execFileSync(
    "bash",
    ["-c", `source "${scriptsDir}/_services.sh"; services_for_mode "${modeName}"`],
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

async function main() {
  const modeArg = process.argv.indexOf("--mode");
  const mode = modeArg === -1 ? "dev" : (process.argv[modeArg + 1] ?? "dev");
  const strict = process.argv.includes("--strict");

  let services;
  try {
    services = servicesFor(mode);
  } catch {
    console.error(`check-env-local: unknown mode '${mode}' (want: dev | h-builds-h)`);
    process.exit(2);
  }

  const envPath = resolve(root, ".env");
  const { declared, usable } = mergeEnv(
    process.env,
    existsSync(envPath) ? parseEnvText(readFileSync(envPath, "utf8")) : {},
  );

  const notes = [];
  let strategies = null;
  try {
    ({ AGENT_STRATEGIES: strategies } = await import(
      resolve(root, "packages/js/agent-cli/dist/index.js")
    ));
  } catch {
    notes.push(
      "agent auth NOT checked — packages/js/agent-cli is not built. Run `bun run build` for the full preflight.",
    );
  }

  const readScript = (service) => {
    const path = resolve(scriptsDir, service);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };

  const { errors, warnings } = collectProblems({
    services,
    readScript,
    declared,
    usable,
    strategies,
  });

  const label = `mode '${mode}' (${services.length} service${services.length === 1 ? "" : "s"})`;

  if (errors.length > 0) {
    console.error(`check-env-local: ${errors.length} missing key(s) — ${label} cannot start:\n`);
    for (const { key, why } of errors) console.error(`  ${key}\n    ${why}\n`);
  }
  for (const { key, why } of warnings) console.error(`check-env-local: WARN ${key} — ${why}`);
  for (const note of notes) console.error(`check-env-local: note — ${note}`);

  if (errors.length > 0 || (strict && warnings.length > 0)) {
    console.error("\nSet these in .env (see .env.example) — .env wins over an exported shell value");
    console.error("here, because every run-*.sh does `set -a; source .env`.");
    process.exit(1);
  }

  const suffix = warnings.length > 0 ? ` (${warnings.length} warning(s) above)` : "";
  console.log(`check-env-local: ok — ${label}${suffix}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
