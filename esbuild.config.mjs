import esbuild from "esbuild";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  banner: { js: "/* calendar-tasks — bundled by esbuild. */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // No Node builtins on purpose: the extension must load on Obsidian mobile (see CLAUDE.md).
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
