import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/doctor": "src/cli/doctor.ts",
    "cli/quick-image": "src/cli/quick-image.ts",
    index: "src/index.ts",
    server: "src/server.ts"
  },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: true,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["sharp", "mediainfo.js"]
});
