// Python AST extraction bridge — shells py-extract.py (stdlib `ast`, no dependencies) and
// applies the shared JS-side line cap. The extractor contract matches ts-extract:
// entry → { lines, stereotype?, realizes? }, so mermaid-class composes it unchanged.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { capLine } from "./sanitize.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "py-extract.py");

function runPy(request) {
  let stdout;
  try {
    stdout = execFileSync("python3", [SCRIPT, JSON.stringify(request)], { encoding: "utf8" });
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    throw new Error(`py-extract (${request.file ?? "<source>"}): ${detail}`);
  }
  const result = JSON.parse(stdout);
  return {
    lines: result.lines.map(capLine),
    stereotype: request.stereotype ?? result.stereotype,
    realizes: result.realizes,
  };
}

/** Source-text entry (the unit tests) — the sibling of ts-extract's fromSource path. */
export function extractPyFromSource(source, entry) {
  return runPy({ ...entry, source });
}

/** File-reading entry (the CLI): resolves the manifest's repo-relative file. */
export function extractPyClass(root, entry, { join: joinPath }) {
  return runPy({ ...entry, file: joinPath(root, entry.file) });
}
