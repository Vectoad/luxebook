import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["luxebook-source"] },
  ssr: { resolve: { conditions: ["luxebook-source"] } },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
