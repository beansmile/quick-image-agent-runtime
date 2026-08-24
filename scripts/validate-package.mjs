import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const errors = [];

if (packageJson.private !== true) errors.push("package.json: package must remain private");
if (packageJson.bin?.["quick-image-local-mcp"] !== "./dist/server.js") {
  errors.push("package.json: quick-image-local-mcp must point to ./dist/server.js");
}
if (packageJson.exports?.["."]?.import !== "./dist/index.js") {
  errors.push("package.json: package root must export ./dist/index.js");
}
if (packageJson.repository?.url !== "git+https://github.com/beansmile/quick-image-agent-runtime.git") {
  errors.push("package.json: unexpected repository URL");
}

for (const required of ["dist/index.js", "dist/index.d.ts", "dist/server.js", "README.md", "LICENSE"]) {
  await access(path.join(root, required)).catch(() => errors.push(`missing required package file: ${required}`));
}

for (const file of await walk(root)) {
  if (file.endsWith(".map")) errors.push(`source map must not be committed or packaged: ${path.relative(root, file)}`);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Package validation passed.\n");
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "coverage"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(entryPath));
    else files.push(entryPath);
  }
  return files;
}
