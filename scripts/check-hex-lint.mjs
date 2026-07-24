#!/usr/bin/env node
// Hex-lint coverage guard — fail LOUDLY when a TypeScript package has hexagonal source layers
// but its lint script does not run dependency-cruiser.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_SUFFIX = "depcruise --config ../../.dependency-cruiser.cjs src";

function packageJsonPaths(parent) {
  const parentPath = resolve(root, parent);
  if (!existsSync(parentPath)) return [];
  return readdirSync(parentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parentPath, entry.name, "package.json"))
    .filter(existsSync);
}

function lintLine(content) {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => /"lint"\s*:/.test(line));
  return index === -1 ? 1 : index + 1;
}

export function checkHexLint() {
  const violations = [];
  const packageJsons = [
    ...packageJsonPaths("apps"),
    ...packageJsonPaths("packages/js"),
  ];

  for (const packageJson of packageJsons) {
    const packageDir = dirname(packageJson);
    const src = join(packageDir, "src");
    const hasHexLayer =
      existsSync(join(src, "domain")) || existsSync(join(src, "presentation"));
    if (!hasHexLayer) continue;

    const content = readFileSync(packageJson, "utf8");
    const pkg = JSON.parse(content);
    if (!String(pkg.scripts?.lint ?? "").includes("depcruise --config")) {
      violations.push({
        file: relative(root, packageJson),
        line: lintLine(content),
      });
    }
  }

  if (violations.length > 0) {
    console.error("✗ check-hex-lint: TypeScript hex package missing dependency-cruiser lint coverage.\n");
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}`);
      console.error(`  Fix: append \` && ${REQUIRED_SUFFIX}\` to scripts.lint.\n`);
    }
    return 1;
  }

  console.log(
    "✓ check-hex-lint: all TypeScript hex packages have dependency-cruiser lint coverage",
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(checkHexLint());
}
