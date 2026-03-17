import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@aura/db/schema", replacement: resolve(__dirname, "../../packages/db/src/schema.ts") },
      { find: "@aura/db", replacement: resolve(__dirname, "../../packages/db/src/index.ts") },
      { find: "@", replacement: resolve(__dirname, "./src") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
