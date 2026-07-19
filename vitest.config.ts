import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      // index.ts is CLI/transport wiring (covered by the manual MCP smoke test),
      // tools.ts is declarative MCP registration around the tested modules.
      exclude: ["src/index.ts", "src/tools.ts"],
    },
  },
});
