/**
 * The repository is its own Claude Code plugin marketplace (`.claude-plugin/marketplace.json`),
 * so `claude plugin marketplace add csitte/mailwarden` + `claude plugin install mailwarden@csitte`
 * installs the plugin without a clone and without Anthropic's directory. The directory refuses,
 * since 6 November 2026, a plugin that runs an MCP server on the user's computer unless it comes
 * from a Verified organization — a status nobody can apply for yet — so this file is the route
 * the README promises. The test keeps the marketplace, the plugin manifest and the README in step.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

// Letters, digits, `.`, `_`, `-`, starting with a letter or digit, no `..` (marketplace reference).
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

describe("Claude Code plugin marketplace", () => {
  it("has a valid name and an owner", () => {
    expect(marketplace.name).toMatch(IDENT);
    expect(marketplace.name).not.toContain("..");
    expect(typeof marketplace.owner?.name).toBe("string");
    expect(typeof marketplace.description).toBe("string");
  });

  it("lists exactly this plugin at the repository root", () => {
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe(plugin.name);
    expect(entry.source).toBe("./");
    expect(typeof entry.description).toBe("string");
  });

  it("leaves the version to plugin.json", () => {
    // plugin.json wins at install time and `claude plugin validate` warns when both set it;
    // the release script bumps plugin.json, so a copy here could only fall behind.
    expect(marketplace.plugins[0]).not.toHaveProperty("version");
    expect(marketplace).not.toHaveProperty("version");
  });

  it("is the route the README names", () => {
    expect(readme).toContain(`claude plugin marketplace add csitte/mailwarden`);
    expect(readme).toContain(`claude plugin install ${plugin.name}@${marketplace.name}`);
  });
});
