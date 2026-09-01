import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runProbe } from "./probe.ts";

/**
 * The probe exists because doctor answered a readiness question with a presence check. These tests
 * pin the distinction that cost a panel half its roster: a binary on PATH is not an agent that can
 * run, and the probe must say which agents actually can — in the strategy's own words.
 */
const AUTH_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_AUTH_MODE",
  "CODEX_ACCESS_TOKEN",
  "LLM_API_KEY",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(AUTH_KEYS.map((k) => [k, process.env[k]]));
  for (const k of AUTH_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const probe = () => Effect.runSync(runProbe({ kind: "probe", op: "agents" }));
const forAgent = (name: string) => probe().agents.find((a) => a.agent === name)!;

describe("runProbe", () => {
  it("covers every agent this substrate can run", () => {
    expect(probe().agents.map((a) => a.agent)).toEqual(["claude", "codex", "openhands", "pi"]);
  });

  it("reports an agent with no credentials as NOT ready", () => {
    expect(forAgent("codex").ready).toBe(false);
  });

  it("names the variables that would fix it, in the strategy's own words", () => {
    // The actionable payload. "codex cannot run" is a fact; this is a fix.
    expect(forAgent("codex").detail).toContain("OPENAI_API_KEY or CODEX_AUTH_MODE=chatgpt");
  });

  it("honours the ChatGPT-subscription path, not just an API key", () => {
    // The exact case doctor got wrong: credentials on disk, opted into by one variable.
    process.env.CODEX_AUTH_MODE = "chatgpt";
    expect(forAgent("codex").ready).toBe(true);
    expect(forAgent("codex").detail).toBeNull();
  });

  it("does not accept an unrelated auth mode as readiness", () => {
    process.env.CODEX_AUTH_MODE = "apikey";
    expect(forAgent("codex").ready).toBe(false);
  });

  it("accepts claude's subscription token as well as its api key", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
    expect(forAgent("claude").ready).toBe(true);
  });

  it("judges each agent independently", () => {
    process.env.LLM_API_KEY = "k";
    const result = probe();
    expect(result.agents.find((a) => a.agent === "openhands")!.ready).toBe(true);
    expect(result.agents.find((a) => a.agent === "codex")!.ready).toBe(false);
  });

  it("answers without a fabric, since credentials are not a registry", () => {
    // Its own job kind rather than a registry op precisely so `h doctor` never needs NATS running
    // to answer a question about auth.
    expect(probe().ok).toBe(true);
  });
});
