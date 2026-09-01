#!/usr/bin/env node
/** Copy Vite dist/ into a version-stamped folder under build/. */
import { cpSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const src = join(root, "dist");
const dest = join(root, "build", `NoneNote-${version}-web`);

if (!existsSync(src)) {
  console.error("dist/ missing — run vite build first");
  process.exit(1);
}

mkdirSync(join(root, "build"), { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`✓ ${dest}`);
