#!/usr/bin/env node
// Runs from npm's `version` lifecycle (after package.json is bumped, before the
// version commit/tag). Copies the new version into server.json so the npm
// package and the MCP-registry manifest never drift apart — and into the Claude
// Code plugin: its manifest version, and every `npx … mailwarden@X.Y.Z` launch in
// the manifest and the skills. The plugin directory refuses an unpinned launcher
// (the code it reviewed could change under it), so the pin has to follow each
// release by itself; `test/plugin-manifest.test.ts` fails the build when it does not.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const server = JSON.parse(readFileSync("server.json", "utf8"));

server.version = version;
if (Array.isArray(server.packages)) {
  for (const p of server.packages) p.version = version;
}

writeFileSync("server.json", JSON.stringify(server, null, 2) + "\n");
console.log(`sync-version: server.json -> ${version}`);

const PIN = /\bmailwarden@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;
const pluginPath = join(".claude-plugin", "plugin.json");
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
plugin.version = version;
for (const entry of Object.values(plugin.mcpServers ?? {})) {
  if (Array.isArray(entry.args)) entry.args = entry.args.map((a) => a.replace(PIN, `mailwarden@${version}`));
}
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
console.log(`sync-version: ${pluginPath} -> ${version}`);

for (const dir of readdirSync("skills", { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const file = join("skills", dir.name, "SKILL.md");
  const before = readFileSync(file, "utf8");
  const after = before.replace(PIN, `mailwarden@${version}`);
  if (after !== before) {
    writeFileSync(file, after);
    console.log(`sync-version: ${file} -> ${version}`);
  }
}
