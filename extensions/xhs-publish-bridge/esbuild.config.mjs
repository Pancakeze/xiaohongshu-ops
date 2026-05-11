import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, "dist");
const watch = process.argv.includes("--watch");

if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
copyFileSync(join(__dirname, "manifest.json"), join(dist, "manifest.json"));

const base = {
  bundle: true,
  platform: "browser",
  logLevel: "info",
  sourcemap: true
};

const ctxBg = await esbuild.context({
  ...base,
  entryPoints: [join(__dirname, "src/background.ts")],
  outfile: join(dist, "background.js"),
  format: "esm"
});

const ctxCt = await esbuild.context({
  ...base,
  entryPoints: [join(__dirname, "src/content.ts")],
  outfile: join(dist, "content.js"),
  format: "iife"
});

if (watch) {
  await Promise.all([ctxBg.watch(), ctxCt.watch()]);
  console.log("watching…");
} else {
  await ctxBg.rebuild();
  await ctxCt.rebuild();
  await ctxBg.dispose();
  await ctxCt.dispose();
}
