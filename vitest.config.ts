import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      // index.ts is CLI/transport wiring only — every decision it used to make inline (mode
      // dispatch, --account parsing, stray-positional detection) now lives in the fully tested
      // src/cli.ts, so what remains is process/transport glue. tools.ts is declarative MCP
      // registration around the tested modules.
      exclude: ["src/index.ts", "src/tools.ts"],
    },
  },
});
