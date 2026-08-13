#!/usr/bin/env node
// Guard the plugin marketplace metadata (plugins/* + the two marketplace manifests) the same
// way the ecosystem's plugin repos do (the checks mirror code-comprehension's
// scripts/validate.sh): every plugin is loadable by BOTH agents — a Claude manifest whose
// name matches its directory and marketplace entry, a Codex manifest at the same version
// pointing .skills at ./skills/, skill frontmatter carrying exactly the two keys both agents
// read (an agent-specific key is ignored at best and rejected at worst), and bundled scripts
// executable. Metadata drift here breaks consumers at INSTALL time, in their repo, not ours.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const failures = [];
const fail = (msg) => failures.push(msg);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const rel = (p) => relative(ROOT, p);

// ---------------------------------------------------------------- Claude side
const claudeMarketplacePath = join(ROOT, ".claude-plugin/marketplace.json");
const claudeMarketplace = readJson(claudeMarketplacePath);
if (!claudeMarketplace) {
  fail(".claude-plugin/marketplace.json is missing or invalid JSON");
} else {
  if (!claudeMarketplace.name) fail(".claude-plugin/marketplace.json has no .name");
  if (!claudeMarketplace.description) fail(".claude-plugin/marketplace.json has no .description");
  const entries = claudeMarketplace.plugins ?? [];
  if (entries.length === 0) fail(".claude-plugin/marketplace.json has an empty .plugins array");
  for (const entry of entries) {
    if (!entry.name) fail("Claude marketplace has a plugin entry with no .name");
    const sourceDir = join(ROOT, (entry.source ?? "").replace(/^\.\//, ""));
    if (!entry.source || !existsSync(sourceDir)) {
      fail(`Claude marketplace source directory does not exist: ${entry.source}`);
    } else {
      const manifest = readJson(join(sourceDir, ".claude-plugin/plugin.json"));
      if (manifest && manifest.name !== entry.name) {
        fail(`Claude marketplace entry ${entry.name} does not match its plugin.json name`);
      }
    }
  }
}

// ------------------------------------------------------------ per-plugin dirs
const pluginsRoot = join(ROOT, "plugins");
let pluginCount = 0;
const pluginDirs = existsSync(pluginsRoot)
  ? readdirSync(pluginsRoot).filter((d) => statSync(join(pluginsRoot, d)).isDirectory())
  : [];
if (pluginDirs.length === 0) fail("no plugins/ directory (or it is empty)");

for (const dirName of pluginDirs) {
  pluginCount += 1;
  const pluginDir = join(pluginsRoot, dirName);
  const claudeJson = readJson(join(pluginDir, ".claude-plugin/plugin.json"));
  if (!claudeJson) {
    fail(`plugin ${dirName} is missing or has invalid .claude-plugin/plugin.json`);
  } else {
    if (claudeJson.name !== dirName) {
      fail(`plugin directory ${dirName} does not match plugin.json name ${claudeJson.name}`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(claudeJson.version ?? "")) {
      fail(`plugin ${dirName} has an invalid version: ${claudeJson.version ?? "<missing>"}`);
    }
  }

  // A plugin must actually ship something an agent can load.
  const contentDirs = ["commands", "skills", "agents", "hooks"];
  if (!contentDirs.some((d) => existsSync(join(pluginDir, d)))) {
    fail(`plugin ${dirName} has no commands/, skills/, agents/, or hooks/ directory`);
  }

  // Bundled scripts are invoked directly by skills, so they must be executable.
  const scriptsDir = join(pluginDir, "scripts");
  if (existsSync(scriptsDir)) {
    for (const script of readdirSync(scriptsDir).filter((f) => f.endsWith(".sh"))) {
      const mode = statSync(join(scriptsDir, script)).mode;
      if (!(mode & 0o111)) fail(`bundled script is not executable: ${rel(join(scriptsDir, script))}`);
    }
  }

  // --------------------------------------------------------- skills + commands
  const skillsDir = join(pluginDir, "skills");
  if (existsSync(skillsDir)) {
    for (const skillName of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, skillName, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const lines = readFileSync(skillFile, "utf8").split("\n");
      if (lines[0] !== "---") {
        fail(`${rel(skillFile)} does not start with --- frontmatter`);
        continue;
      }
      // Frontmatter must carry exactly the two keys both agents read.
      const keys = [];
      for (const line of lines.slice(1)) {
        if (line === "---") break;
        const m = line.match(/^([A-Za-z0-9_-]+):/);
        if (m) keys.push(m[1]);
      }
      if (keys.sort().join(" ") !== "description name") {
        fail(`${rel(skillFile)} frontmatter keys should be exactly name+description, found: ${keys.join(" ") || "<none>"}`);
      }
    }
  }

  const commandsDir = join(pluginDir, "commands");
  if (existsSync(commandsDir)) {
    for (const cmd of readdirSync(commandsDir).filter((f) => f.endsWith(".md"))) {
      const head = readFileSync(join(commandsDir, cmd), "utf8").split("\n").slice(0, 3);
      if (!head.some((l) => l.startsWith("description:"))) {
        fail(`${rel(join(commandsDir, cmd))} is missing description: frontmatter`);
      }
    }
  }
}

// ----------------------------------------------------------------- Codex side
const codexMarketplacePath = join(ROOT, ".agents/plugins/marketplace.json");
const codexMarketplace = readJson(codexMarketplacePath);
if (!codexMarketplace) {
  fail(".agents/plugins/marketplace.json is missing or invalid JSON");
} else {
  if (!codexMarketplace.name) fail(".agents/plugins/marketplace.json has no .name");
  for (const entry of codexMarketplace.plugins ?? []) {
    const sourcePath = entry.source?.path ?? "";
    const pluginDir = join(ROOT, sourcePath.replace(/^\.\//, ""));
    const codexJson = readJson(join(pluginDir, ".codex-plugin/plugin.json"));
    if (!existsSync(pluginDir) || !codexJson) {
      fail(`Codex plugin source or manifest is invalid: ${sourcePath}`);
      continue;
    }
    const installation = entry.policy?.installation;
    if (!["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(installation)) {
      fail(`invalid Codex installation policy for ${entry.name}: ${installation}`);
    }
    const authentication = entry.policy?.authentication;
    if (!["ON_INSTALL", "ON_USE"].includes(authentication)) {
      fail(`invalid Codex authentication policy for ${entry.name}: ${authentication}`);
    }
    if (!entry.category) fail(`missing Codex category for ${entry.name}`);
    if (codexJson.name !== entry.name) {
      fail(`Codex marketplace and plugin names differ for ${entry.name}`);
    }
    if (codexJson.skills !== "./skills/") {
      fail(`Codex manifest for ${entry.name} should point .skills at ./skills/`);
    }
    const claudeJson = readJson(join(pluginDir, ".claude-plugin/plugin.json"));
    if (claudeJson && claudeJson.version !== codexJson.version) {
      fail(`Claude and Codex plugin versions differ for ${entry.name}`);
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  console.error(`\ncheck-plugins: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`check-plugins OK: ${pluginCount} plugin(s) valid for Claude Code and Codex`);
