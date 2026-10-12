/**
 * The Claude Code plugin manifest and its skills name the package version in three places
 * that `npm version` cannot bump by itself — so `scripts/sync-version.mjs` does it, and this
 * test fails the build when any of them falls behind `package.json`.
 *
 * Why the pin exists at all: Anthropic's plugin directory refuses an unpinned launcher
 * (`npx -y mailwarden`, `@latest`, a range). A reviewer approves one revision; an unpinned
 * launch runs whatever npm serves later. The directory held the 15 August submission on exactly
 * this finding (`.claude-plugin/plugin.json · mcpServers.mailwarden`, checked 23 September).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));

describe("Claude Code plugin manifest", () => {
  it("carries the package version", () => {
    expect(plugin.version).toBe(version);
  });

  it("launches an exactly pinned package", () => {
    const servers = Object.entries(plugin.mcpServers ?? {});
    expect(servers.length).toBeGreaterThan(0);
    for (const [name, entry] of servers as [string, { command: string; args?: string[] }][]) {
      const args = entry.args ?? [];
      const pkg = args.find((a) => a.startsWith("mailwarden"));
      expect(pkg, `${name}: no mailwarden package in args`).toBe(`mailwarden@${version}`);
      expect(args.some((a) => /@latest$/.test(a) || /@[\^~]/.test(a))).toBe(false);
    }
  });
});

describe("plugin skills", () => {
  const skillFiles = readdirSync(join(root, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, "skills", d.name, "SKILL.md"));

  it("exist", () => {
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  for (const file of skillFiles) {
    const text = readFileSync(file, "utf8");
    it(`${file.slice(root.length + 1)} launches mailwarden only at the package version`, () => {
      // Every `npx [-y] mailwarden` is followed by `@<version>` — no bare launch, no other version.
      const bare = text.match(/npx(?: -y)? mailwarden(?![@\w-])/g) ?? [];
      expect(bare, "unpinned npx launch").toEqual([]);
      const pins = text.match(/\bmailwarden@[0-9][^\s`'")]*/g) ?? [];
      for (const pin of pins) expect(pin).toBe(`mailwarden@${version}`);
    });
  }
});
