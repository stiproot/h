// Unit tests for the diagram-generation toolkit (node --test, wired into root `bun run test`).
// Extraction is tested over SOURCE TEXT (fromSource) — no filesystem, no fixtures on disk.

import assert from "node:assert/strict";
import { test } from "node:test";

import { capLine, shortType } from "./sanitize.mjs";
import { extractFromSource, fromSource } from "./ts-extract.mjs";
import { extractPyFromSource } from "./py-extract.mjs";
import { generateClassDiagram } from "./mermaid-class.mjs";
import { parseManifest, replaceFence } from "./managed-doc.mjs";

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------

test("shortType keeps outer generic name + first argument only (mermaid cannot carry commas)", () => {
  assert.equal(shortType("Effect.Effect<InvocationResult, LiteLlmError, HttpClient>"), "Effect~InvocationResult~");
  assert.equal(shortType("Record<string, number>"), "Record~string~");
  assert.equal(shortType("string"), "string");
});

test("shortType flattens object literals and function types", () => {
  assert.equal(shortType("{ input: number; output: number }"), "object");
  assert.equal(shortType("(event: Record<string, unknown>) => void"), "fn");
});

test("capLine truncates deterministically past 72 chars", () => {
  const long = "x".repeat(100);
  assert.equal(capLine(long).length, 70); // 69 + ellipsis
  assert.equal(capLine("short"), "short");
});

// ---------------------------------------------------------------------------
// ts-extract
// ---------------------------------------------------------------------------

const SRC = `
export interface Greeter {
  name: string;
  model?: string;
  greet(who: string): Promise<string>;
  onEvent?: (event: SomeEvent) => void;
}
export type Mood = "happy" | "grumpy";
export const politeGreeter: Greeter = { name: "p", greet: async (w) => w };
export function shout({ text, volume }: Opts): string { return text; }
export const whisper = (text: string): string => text;
`;

test("interface extraction: props, optionality, methods, function-typed props as methods", () => {
  const src = fromSource(SRC);
  const { lines, stereotype } = extractFromSource(src, {
    kind: "interface",
    symbol: "Greeter",
  });
  assert.equal(stereotype, "interface");
  assert.deepEqual(lines, [
    "+name string",
    "+model? string",
    "+greet(who) Promise~string~",
    "+onEvent?(event) void",
  ]);
});

test("union extraction renders the arms unquoted", () => {
  const { lines, stereotype } = extractFromSource(fromSource(SRC), {
    kind: "union",
    symbol: "Mood",
  });
  assert.equal(stereotype, "union");
  assert.deepEqual(lines, ["happy | grumpy"]);
});

test("const extraction: curated note becomes the body, annotation becomes the realization", () => {
  const { lines, realizes } = extractFromSource(fromSource(SRC), {
    kind: "const",
    symbol: "politeGreeter",
    note: "always says please",
  });
  assert.deepEqual(lines, ["always says please"]);
  assert.equal(realizes, "Greeter");
});

test("module extraction: fn declarations + arrow consts; destructured params render as opts", () => {
  const { lines } = extractFromSource(fromSource(SRC), {
    kind: "module",
    file: "x/greeter.ts",
    functions: ["shout", "whisper"],
  });
  assert.deepEqual(lines, ["+shout(opts) string", "+whisper(text) string"]);
});

test("a missing symbol fails loudly, never a silent empty class", () => {
  assert.throws(
    () => extractFromSource(fromSource(SRC), { kind: "interface", symbol: "Nope" }),
    /interface Nope not found/,
  );
});

// ---------------------------------------------------------------------------
// py-extract (source-text entry — shells the stdlib-ast script, no fixtures on disk)
// ---------------------------------------------------------------------------

const PY_SRC = `
from dataclasses import dataclass

JUDGE = "run-claude"
TABLE: dict[str, tuple[str, str]] = {}

@dataclass(frozen=True)
class MemberRef:
    key: str | None = None
    templates: tuple[str, ...] = ()
    _secret: int = 0

    @property
    def label(self) -> str:
        return ""

    def merge(self, other: "MemberRef") -> "MemberRef":
        return other

def parse_expr(tokens: list[str]) -> "ChainExpr":
    ...
`;

test("py class extraction: public annotated fields, properties, public methods; frozen dataclass stereotype", () => {
  const { lines, stereotype } = extractPyFromSource(PY_SRC, { kind: "class", symbol: "MemberRef" });
  assert.equal(stereotype, "frozen dataclass");
  assert.deepEqual(lines, [
    "+key str | None",
    "+templates tuple~str~",
    "+label str",
    "+merge(other) MemberRef",
  ]);
});

test("py module extraction: consts (annotation or string value) then function signatures", () => {
  const { lines, stereotype } = extractPyFromSource(PY_SRC, {
    kind: "module",
    functions: ["parse_expr"],
    consts: ["JUDGE", "TABLE"],
  });
  assert.equal(stereotype, "module <source>");
  assert.deepEqual(lines, [
    "+JUDGE (run-claude)",
    "+TABLE dict~str~",
    "+parse_expr(tokens) ChainExpr",
  ]);
});

test("py extraction fails loudly on a missing symbol, never a silent empty class", () => {
  assert.throws(
    () => extractPyFromSource(PY_SRC, { kind: "class", symbol: "Nope" }),
    /class Nope not found/,
  );
});

// ---------------------------------------------------------------------------
// mermaid-class assembly
// ---------------------------------------------------------------------------

const MANIFEST = {
  direction: "LR",
  classes: [
    { id: "Greeter", kind: "interface", symbol: "Greeter" },
    { id: "politeGreeter", kind: "const", symbol: "politeGreeter", note: "polite" },
  ],
  relations: [["Greeter", "politeGreeter", null, "example"]],
};

const stubExtract = (entry) =>
  entry.kind === "interface"
    ? { lines: ["+greet(who) string"], stereotype: "interface" }
    : { lines: ["polite"], realizes: "Greeter" };

test("generateClassDiagram: realization derives from the extractor, relations from the manifest", () => {
  const out = generateClassDiagram(MANIFEST, stubExtract);
  assert.match(out, /direction LR/);
  assert.match(out, /politeGreeter \.\.\|> Greeter/);
  assert.match(out, /Greeter --> politeGreeter : example/);
});

test("generateClassDiagram is deterministic (same input → identical output)", () => {
  assert.equal(
    generateClassDiagram(MANIFEST, stubExtract),
    generateClassDiagram(MANIFEST, stubExtract),
  );
});

// ---------------------------------------------------------------------------
// managed-doc
// ---------------------------------------------------------------------------

const DOC = `# title

<!-- gen:c4-code {"direction":"LR","classes":[]} -->

\`\`\`mermaid
classDiagram
\`\`\`

notes
`;

test("parseManifest reads the marker; unmanaged docs return null", () => {
  assert.deepEqual(parseManifest(DOC), { direction: "LR", classes: [] });
  assert.equal(parseManifest("# plain doc"), null);
});

test("replaceFence swaps only the fence and is idempotent for identical diagrams", () => {
  const once = replaceFence(DOC, "classDiagram\n  class X {\n  }\n");
  assert.match(once, /class X/);
  assert.match(once, /notes/);
  assert.equal(replaceFence(once, "classDiagram\n  class X {\n  }\n"), once);
});

test("replaceFence fails loudly when the doc has no fence", () => {
  assert.throws(() => replaceFence("# no fence", "classDiagram\n"), /no mermaid fence/);
});
