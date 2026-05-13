import * as esbuild from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, "dist");
const watch = process.argv.includes("--watch");

if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

/** P0-5：构建时合并 `externally_connectable.matches`（生产/预发 HTTPS 运营台） */
function writeManifestToDist() {
  const manifestPath = join(__dirname, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const extra = process.env.XHS_BRIDGE_APP_ORIGINS || "";
  const matches = new Set(
    Array.isArray(manifest.externally_connectable?.matches)
      ? manifest.externally_connectable.matches
      : []
  );
  for (const raw of extra.split(",")) {
    const o = raw.trim().replace(/\/$/, "");
    if (!o.startsWith("https://")) continue;
    try {
      const u = new URL(o);
      if (u.username || u.password) continue;
      matches.add(`${u.origin}/*`);
    } catch {
      /* ignore invalid */
    }
  }
  manifest.externally_connectable = manifest.externally_connectable || {};
  manifest.externally_connectable.matches = [...matches];
  writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

writeManifestToDist();

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
