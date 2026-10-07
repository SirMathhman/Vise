/** Bundle the Firefox extension's scripts into `extension/dist/` (load `extension/manifest.json` in Firefox). */
const result = await Bun.build({
  entrypoints: ["background", "dialogs", "sidebar", "options"].map(
    (name) => `./extension/src/${name}.ts`,
  ),
  outdir: "./extension/dist",
  target: "browser",
  minify: false,
  // The same stamp goes into every script, so the sidebar can tell when the background page is an older build.
  define: { __VISE_BUILD__: JSON.stringify(String(Date.now())) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
