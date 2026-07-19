#!/usr/bin/env node
// Runs from npm's `version` lifecycle (after package.json is bumped, before the
// version commit/tag). Copies the new version into server.json so the npm
// package and the MCP-registry manifest never drift apart.
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const server = JSON.parse(readFileSync("server.json", "utf8"));

server.version = version;
if (Array.isArray(server.packages)) {
  for (const p of server.packages) p.version = version;
}

writeFileSync("server.json", JSON.stringify(server, null, 2) + "\n");
console.log(`sync-version: server.json -> ${version}`);
