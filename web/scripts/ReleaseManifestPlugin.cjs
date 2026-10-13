const { createHash } = require("node:crypto");

// Hash the finished HTML, which references the hashed JS (and, through it,
// the hashed map style).
module.exports = class ReleaseManifestPlugin {
  apply(compiler) {
    const { Compilation, sources } = compiler.webpack;
    compiler.hooks.thisCompilation.tap(
      "ReleaseManifestPlugin",
      (compilation) => {
        compilation.hooks.processAssets.tap(
          {
            name: "ReleaseManifestPlugin",
            stage: Compilation.PROCESS_ASSETS_STAGE_REPORT,
          },
          () => {
            const html = compilation
              .getAsset("index.html")
              .source.source()
              .toString();
            const version = createHash("sha256")
              .update(html)
              .digest("hex")
              .slice(0, 20);
            compilation.updateAsset(
              "index.html",
              new sources.RawSource(
                html.replace(
                  "</head>",
                  `<meta name="app-version" content="${version}"></head>`,
                ),
              ),
            );
            compilation.emitAsset(
              "version.json",
              new sources.RawSource(JSON.stringify({ version }) + "\n"),
            );
          },
        );
      },
    );
  }
};
