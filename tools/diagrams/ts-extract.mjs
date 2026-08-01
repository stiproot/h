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

// --- Effect Schema struct extraction (kind: "schema") -----------------------------------
// workflow-svc's domain models are `export const X = Schema.Struct({...})` consts, not
// interfaces — the runtime schema IS the shape declaration, so members extract from the
// struct's object literal. Field types map to plain type text (Schema.String → string,
// optional/optionalWith unwrap to `?`, Literal arms join with |, identifier references
// keep their schema's name).

const findConstDecl = (src, name) => {
  const stmt = findTopLevel(
    src,
    (s) =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some((d) => d.name.getText(src) === name),
  );
  return stmt?.declarationList.declarations.find((d) => d.name.getText(src) === name);
};

function schemaTypeText(src, node) {
  if (ts.isCallExpression(node)) {
    const tail = node.expression.getText(src).split(".").pop();
    const args = node.arguments;
    if (tail === "Literal") return args.map((a) => schemaTypeText(src, a)).join(" | ");
    if (tail === "Union") return args.map((a) => schemaTypeText(src, a)).join(" | ");
    if (tail === "Array") return `${schemaTypeText(src, args[0])}[]`;
    if (tail === "Record") return "Record";
    if (tail === "Struct") return "object";
    if (tail === "suspend" || tail === "optional" || tail === "optionalWith") {
      return args.length > 0 ? schemaTypeText(src, args[0]) : tail;
    }
    return tail;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const tail = node.name.getText(src);
    const primitive = { String: "string", Number: "number", Boolean: "boolean", Unknown: "unknown", Any: "any" };
    return primitive[tail] ?? tail;
  }
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return node.getText(src);
  return shortType(node.getText(src));
}

const isOptionalField = (src, node) =>
  ts.isCallExpression(node) && /\.optional(With)?$/.test(node.expression.getText(src));

function schemaFieldLines(src, objectLiteral, where) {
  const lines = [];
  for (const prop of objectLiteral.properties) {
    if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
      const spread = findConstDecl(src, prop.expression.getText(src));
      const init = spread?.initializer && unwrapExpression(spread.initializer);
      if (init && ts.isObjectLiteralExpression(init)) {
        lines.push(...schemaFieldLines(src, init, where));
      }
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name.getText(src);
    const opt = isOptionalField(src, prop.initializer) ? "?" : "";
    lines.push(capLine(`+${name}${opt} ${schemaTypeText(src, prop.initializer)}`));
  }
  return lines;
}

// Peel `as const` / `satisfies` / parens off an expression (shared-fields consts use them).
function unwrapExpression(node) {
  let n = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) {
    n = n.expression;
  }
  return n;
}

function schemaStructLiteral(src, node, where) {
  // Unwrap `.pipe(...)` wrappers and resolve `Schema.Struct(SharedFields)` identifiers.
  if (ts.isCallExpression(node) && node.expression.getText(src).endsWith(".pipe")) {
    return schemaStructLiteral(src, node.expression.expression, where);
  }
  if (ts.isCallExpression(node)) {
    const arg = node.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) return arg;
    if (arg && ts.isIdentifier(arg)) {
      const shared = findConstDecl(src, arg.getText(src));
      const init = shared?.initializer && unwrapExpression(shared.initializer);
      if (init && ts.isObjectLiteralExpression(init)) return init;
    }
  }
  throw new Error(`${where}: not a Schema.Struct const with a resolvable field literal`);
}

/**
 * Extract one manifest class entry from a SourceFile → { lines, stereotype, realizes }.
 * Kinds: interface | union | const (typed const; note curated, realization from the
 * annotation) | module (listed exported functions) | schema (Effect Schema.Struct const —
 * fields from the struct literal, spreads and shared-fields identifiers resolved).
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

  if (kind === "schema") {
    const decl = findConstDecl(src, entry.symbol);
    if (!decl?.initializer) {
      throw new Error(`${entry.file ?? src.fileName}: schema const ${entry.symbol} not found`);
    }
    const where = `${entry.file ?? src.fileName}: ${entry.symbol}`;
    const literal = schemaStructLiteral(src, decl.initializer, where);
    return {
      lines: schemaFieldLines(src, literal, where),
      stereotype: entry.stereotype ?? "Effect Schema struct",
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
