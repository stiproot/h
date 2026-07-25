#!/usr/bin/env node
// Local port allocation guard. Keep each run script's stale-port cleanup, Dapr flags, and the
// README port map in lockstep so local restarts cannot fail with a misleading EADDRINUSE.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runScriptsDir = resolve(root, "cli/scripts");
const readmePath = resolve(root, "README.md");

function location(path, line) {
  return `${relative(root, path)}:${line}`;
}

function samePorts(left, right) {
  return left.size === right.size && [...left].every((port) => right.has(port));
}

function correctedRow(service, stopPorts, flags) {
  const flagged = new Set(flags.map(({ port }) => port));
  const appPorts = [
    ...stopPorts.filter((port) => !flagged.has(port)),
    ...flags.filter(({ flag }) => flag === "--app-port").map(({ port }) => port),
  ];
  const cell = (flag) => flags.find((entry) => entry.flag === flag)?.port ?? "—";
  return `| \`${service}\` | ${appPorts.join(" / ") || "—"} | ${cell("--dapr-http-port")} | ${cell("--dapr-grpc-port")} | ${cell("--dapr-internal-grpc-port")} |`;
}

export function checkPorts() {
  const errors = [];
  const scripts = [];

  for (const file of readdirSync(runScriptsDir)
    .filter((name) => /^run-.+\.sh$/.test(name))
    .sort()) {
    const path = join(runScriptsDir, file);
    const lines = readFileSync(path, "utf8").split("\n");
    const stopIndex = lines.findIndex((line) => /^\s*stop_stale\s+/.test(line));
    const service = file.slice("run-".length, -".sh".length);

    if (stopIndex === -1) {
      errors.push(
        `${location(path, 1)}: missing stop_stale declaration. Fix: add \`stop_stale ${service} <ports…>\`.`,
      );
      continue;
    }

    const stopMatch = lines[stopIndex].match(/^\s*stop_stale\s+(\S+)((?:\s+\d+)+)\s*(?:#.*)?$/);
    if (!stopMatch) {
      errors.push(
        `${location(path, stopIndex + 1)}: cannot parse stop_stale declaration. Fix: use \`stop_stale ${service} <ports…>\` with literal numeric ports.`,
      );
      continue;
    }

    const stopPorts = stopMatch[2].trim().split(/\s+/);
    const flags = [];
    lines.forEach((line, index) => {
      for (const match of line.matchAll(
        /(--app-port|--dapr-http-port|--dapr-grpc-port|--dapr-internal-grpc-port)(?:=|\s+)(\d+)/g,
      )) {
        flags.push({ flag: match[1], port: match[2], line: index + 1 });
      }
    });

    for (const { flag, port, line } of flags) {
      if (!stopPorts.includes(port)) {
        errors.push(
          `${location(path, line)}: ${flag} ${port} is absent from stop_stale. Fix: replace the declaration with \`stop_stale ${stopMatch[1]} ${[...stopPorts, port].join(" ")}\`.`,
        );
      }
    }
    scripts.push({ path, service, stopLine: stopIndex + 1, stopPorts, flags });
  }

  const owners = new Map();
  for (const script of scripts) {
    for (const port of script.stopPorts) {
      const owner = owners.get(port);
      if (owner && owner.path !== script.path) {
        errors.push(
          `${location(script.path, script.stopLine)}: port ${port} duplicates ${location(owner.path, owner.line)}. Fix: assign ${script.service} a unique port and update its stop_stale line, Dapr flag, and README row.`,
        );
      } else {
        owners.set(port, { path: script.path, line: script.stopLine });
      }
    }
  }

  const readmeLines = readFileSync(readmePath, "utf8").split("\n");
  const headingIndex = readmeLines.findIndex(
    (line) => line.trim() === "## Port allocation (local dev)",
  );
  if (headingIndex === -1) {
    errors.push(
      "README.md:1: missing `## Port allocation (local dev)` table. Fix: restore the heading and port allocation table.",
    );
  } else {
    const rows = new Map();
    for (let index = headingIndex + 1; index < readmeLines.length; index += 1) {
      const line = readmeLines[index];
      if (index > headingIndex + 2 && line.trim() === "") break;
      const match = line.match(/^\|\s*`([^`]+)`\s*\|/);
      if (match) rows.set(match[1], { line, lineNumber: index + 1 });
    }

    for (const script of scripts) {
      const row = rows.get(script.service);
      const fix = correctedRow(script.service, script.stopPorts, script.flags);
      if (!row) {
        errors.push(
          `README.md:${headingIndex + 1}: missing port row for ${script.service}. Fix: add this row:\n  ${fix}`,
        );
        continue;
      }
      const readmePorts = new Set(row.line.match(/\b\d+\b/g) ?? []);
      const stopPorts = new Set(script.stopPorts);
      if (!samePorts(readmePorts, stopPorts)) {
        errors.push(
          `README.md:${row.lineNumber}: ports for ${script.service} do not match ${location(script.path, script.stopLine)}. Fix: replace the row with:\n  ${fix}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error("✗ check-ports: local port allocation drift found.\n");
    for (const error of errors) console.error(`  ${error}`);
    return 1;
  }

  console.log(
    "✓ check-ports: run-script ports are unique, Dapr flags are covered by stop_stale, and README ports match",
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(checkPorts());
}
