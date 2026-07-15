import { describe, expect, it } from "vitest";

import {
  StructuredOutputError,
  applyOutputContract,
  contractViolations,
  lastFencedJson,
  parseStructuredOutput,
  unsupportedContractKeywords,
} from "./structured-output.ts";

const PR_CONTRACT = {
  type: "object",
  required: ["pr"],
  properties: {
    pr: { type: "integer", description: "the PR number" },
    url: { type: "string" },
  },
};

const fenced = (body: string) => "narrative first\n\n```json\n" + body + "\n```\n";

describe("lastFencedJson", () => {
  it("returns undefined when no fenced json block exists", () => {
    expect(lastFencedJson("just prose, ===PR=== markers, no fence")).toBeUndefined();
  });

  it("takes the LAST block — an earlier quoted example must not shadow the answer", () => {
    const output = fenced('{"pr": 1}') + "\nmore prose\n" + fenced('{"pr": 42}');
    expect(lastFencedJson(output)).toContain('"pr": 42');
  });

  it("ignores fenced blocks of other languages", () => {
    expect(lastFencedJson("```ts\nconst x = 1;\n```")).toBeUndefined();
  });
});

describe("unsupportedContractKeywords (fail-closed subset)", () => {
  it("accepts the supported subset, including nested properties and items", () => {
    const contract = {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { enum: ["CLEAN", "FINDINGS"] },
        commentIds: { type: "array", items: { type: "string" } },
        count: { const: 3, title: "t", description: "d" },
      },
    };
    expect(unsupportedContractKeywords(contract)).toEqual([]);
  });

  it("rejects unsupported keywords, naming the path — never partially enforced", () => {
    const problems = unsupportedContractKeywords({
      type: "object",
      properties: { url: { type: "string", pattern: "^https://" } },
    });
    expect(problems).toEqual(["$.url: unsupported keyword 'pattern'"]);
  });

  it("rejects unsupported types and non-object schemas", () => {
    expect(unsupportedContractKeywords({ type: "date" })).toEqual(["$: unsupported type 'date'"]);
    expect(unsupportedContractKeywords("not a schema")).toEqual([
      "$: a contract schema must be a JSON object",
    ]);
  });
});

describe("contractViolations", () => {
  it("passes a conforming value and allows undeclared extra keys", () => {
    expect(contractViolations({ pr: 42, extra: true }, PR_CONTRACT)).toEqual([]);
  });

  it("reports missing required, wrong types, and enum misses with paths", () => {
    const contract = {
      type: "object",
      required: ["verdict", "summary"],
      properties: {
        verdict: { enum: ["CLEAN", "FINDINGS"] },
        commentIds: { type: "array", items: { type: "string" } },
      },
    };
    const problems = contractViolations({ verdict: "MAYBE", commentIds: ["a", 7] }, contract);
    expect(problems).toContain("$: missing required 'summary'");
    expect(problems).toContain('$.verdict: value "MAYBE" not in enum');
    expect(problems).toContain("$.commentIds[1]: expected string, got number");
  });

  it("distinguishes integer from number", () => {
    expect(contractViolations({ pr: 4.5 }, PR_CONTRACT)).toEqual([
      "$.pr: expected integer, got number",
    ]);
  });
});

describe("parseStructuredOutput", () => {
  it("returns the validated value from the last fenced block", () => {
    const value = parseStructuredOutput(
      fenced('{"pr": 42, "url": "https://x/pull/42"}'),
      PR_CONTRACT,
    );
    expect(value).toEqual({ pr: 42, url: "https://x/pull/42" });
  });

  it("fails loud when the block is absent", () => {
    expect(() => parseStructuredOutput("prose only", PR_CONTRACT)).toThrow(
      /no fenced ```json block/,
    );
  });

  it("fails loud on malformed JSON", () => {
    expect(() => parseStructuredOutput(fenced("{nope"), PR_CONTRACT)).toThrow(/not valid JSON/);
  });

  it("fails loud on a contract violation", () => {
    expect(() => parseStructuredOutput(fenced('{"url": "x"}'), PR_CONTRACT)).toThrow(
      /violates its contract: \$: missing required 'pr'/,
    );
  });

  it("fails CLOSED on a contract outside the subset — even if the value would pass", () => {
    expect(() =>
      parseStructuredOutput(fenced('{"pr": 42}'), { type: "object", oneOf: [] }),
    ).toThrow(/outside the supported subset.*oneOf/);
  });

  it("throws StructuredOutputError specifically", () => {
    expect(() => parseStructuredOutput("prose", PR_CONTRACT)).toThrow(StructuredOutputError);
  });
});

describe("applyOutputContract (the run-activity seam)", () => {
  it("passes the result through untouched when no contract is declared", () => {
    const result = { sessionId: "s", output: "no fence here at all" };
    expect(applyOutputContract(result, undefined)).toBe(result);
  });

  it("attaches the validated block as `structured`", () => {
    const result = { sessionId: "s", output: fenced('{"pr": 7}') };
    expect(applyOutputContract(result, PR_CONTRACT)).toEqual({ ...result, structured: { pr: 7 } });
  });

  it("fails the step (throws) when the contract is declared but unmet", () => {
    expect(() => applyOutputContract({ output: "prose" }, PR_CONTRACT)).toThrow(
      StructuredOutputError,
    );
  });
});
