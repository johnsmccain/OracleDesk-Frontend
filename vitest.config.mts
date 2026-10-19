import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    projects: [
      {
        // Pure logic: no DOM needed.
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["lib/**/*.test.ts"],
          typecheck: { enabled: true, include: ["lib/**/*.test-d.ts"], tsconfig: "./tsconfig.json" },
        },
      },
      {
        // React rendering: needs a DOM.
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["components/**/*.test.tsx", "components/**/*.test.ts", "app/**/*.test.tsx", "lib/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
          typecheck: { enabled: false },
        },
      },
    ],
  },
});
