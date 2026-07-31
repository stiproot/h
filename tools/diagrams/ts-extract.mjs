// TypeScript AST extraction — the "members are code truth" half of the generated-diagram
// split (tools/diagrams/README.md). Pure over source TEXT (`fromSource`) so every rule is
// unit-testable without touching the filesystem; `extractClass` composes file reading on top.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { capLine, shortType } from "./sanitize.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Parse source TEXT into a SourceFile (the unit-test entry). */
export function fromSource(text, name = "virtual.ts") {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

/** A destructured parameter's binding pattern must not leak verbatim — render it as `opts`. */
const paramName = (src, p) => (ts.isIdentifier(p.name) ? p.name.getText(src) : "opts");

/** Member lines for an interface/class declaration — methods, props, and function-typed
 * properties rendered as methods (the Effect-service idiom). */
export function memberLines(src, decl) {
  const lines = [];
  for (const m of decl.members) {
    const name = m.name?.getText(src);
    if (!name) continue;
    const opt = m.questionToken ? "?" : "";
    if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
      const params = m.parameters.map((p) => paramName(src, p)).join(", ");
      const ret = m.type ? ` ${shortType(m.type.getText(src))}` : "";
      lines.push(capLine(`+${name}${opt}(${params})${ret}`));
    } else if (
      (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) &&
      m.type &&
      ts.isFunctionTypeNode(m.type)
    ) {
      const params = m.type.parameters.map((p) => paramName(src, p)).join(", ");
      const ret = m.type.type ? ` ${shortType(m.type.type.getText(src))}` : "";
      lines.push(capLine(`+${name}${opt}(${params})${ret}`));
    } else if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
      const t = m.type ? ` ${shortType(m.type.getText(src))}` : "";
      lines.push(capLine(`+${name}${opt}${t}`));
    }
  }
  return lines;
}

const findTopLevel = (src, predicate) => src.statements.find(predicate);

/**
 * Extract one manifest class entry from a SourceFile → { lines, stereotype, realizes }.
 * Kinds: interface | union | const (typed const; note curated, realization from the
 * annotation) | module (listed exported functions).
 */
export function extractFromSource(src, entry) {
  const kind = entry.kind;

  if (kind === "interface") {
    const decl = findTopLevel(
      src,
      (s) => ts.isInterfaceDeclaration(s) && s.name.text === entry.symbol,
    );
    if (!decl) throw new Error(`${entry.file ?? src.fileName}: interface ${entry.symbol} not found`);
    return { lines: memberLines(src, decl), stereotype: entry.stereotype ?? "interface" };
  }

  if (kind === "union") {
    const decl = findTopLevel(
      src,
      (s) => ts.isTypeAliasDeclaration(s) && s.name.text === entry.symbol,
    );
    if (!decl) throw new Error(`${entry.file ?? src.fileName}: type ${entry.symbol} not found`);
    const arms = decl.type.getText(src).replace(/\s+/g, " ").replace(/"/g, "");
    return { lines: [capLine(arms)], stereotype: entry.stereotype ?? "union" };
  }

  if (kind === "const") {
    const stmt = findTopLevel(
      src,
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some((d) => d.name.getText(src) === entry.symbol),
    );
    if (!stmt) throw new Error(`${entry.file ?? src.fileName}: const ${entry.symbol} not found`);
    const decl = stmt.declarationList.declarations.find(
      (d) => d.name.getText(src) === entry.symbol,
    );
    const annotated = decl.type ? decl.type.getText(src).replace(/\s+/g, " ") : undefined;
    // The note is manifest-curated; the REALIZATION edge is AST truth (the type annotation).
    return {
      lines: entry.note ? [capLine(entry.note)] : [],
      stereotype: entry.stereotype,
      realizes: annotated,
    };
  }

  if (kind === "module") {
    const lines = [];
    for (const fn of entry.functions) {
      const decl = findTopLevel(src, (s) => ts.isFunctionDeclaration(s) && s.name?.text === fn);
      if (decl) {
        const params = decl.parameters.map((p) => paramName(src, p)).join(", ");
        const ret = decl.type ? ` ${shortType(decl.type.getText(src))}` : "";
        lines.push(capLine(`+${fn}(${params})${ret}`));
        continue;
      }
      const stmt = findTopLevel(
        src,
        (s) =>
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.some((d) => d.name.getText(src) === fn),
      );
      if (!stmt) throw new Error(`${entry.file ?? src.fileName}: function ${fn} not found`);
      const vd = stmt.declarationList.declarations.find((d) => d.name.getText(src) === fn);
      const init = vd.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        const params = init.parameters.map((p) => paramName(src, p)).join(", ");
        const ret = init.type ? ` ${shortType(init.type.getText(src))}` : "";
        lines.push(capLine(`+${fn}(${params})${ret}`));
      } else {
        lines.push(capLine(`+${fn}`));
      }
    }
    return { lines, stereotype: entry.stereotype ?? `module ${entry.file.split("/").pop()}` };
  }

  throw new Error(`unknown kind "${kind}" for ${entry.id}`);
}

/** File-reading composition of {@link extractFromSource} (the CLI entry). */
export function extractClass(root, entry, { join }) {
  const abs = join(root, entry.file);
  return extractFromSource(fromSource(readFileSync(abs, "utf8"), abs), entry);
}
