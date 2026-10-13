// Exercise the production webpack config with small fixtures, not mocked hooks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const webpack = require("webpack");
const config = require("../webpack.config.js");

async function main() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zet-release-build-"),
  );
  const html = fs.readFileSync(
    path.join(__dirname, "../public/index.html"),
    "utf8",
  );
  const entry =
    'import style from "./BUILD/style.json?url"; window.releaseFixture = {style, value: 1};';
  const style = JSON.stringify({ version: 8, sources: {}, layers: [] });
  const write = (name, contents) =>
    fs.writeFileSync(path.join(directory, name), contents);
  const build = async () => {
    const production = config({}, { mode: "production" });
    const compiler = webpack({
      ...production,
      mode: "production",
      context: directory,
      entry: "./entry.js",
      output: { ...production.output, path: path.join(directory, "output") },
    });
    const stats = await new Promise((resolve, reject) =>
      compiler.run((error, stats) => {
        compiler.close((closeError) =>
          error || closeError ? reject(error || closeError) : resolve(stats),
        );
      }),
    );
    assert.ok(!stats.hasErrors(), stats.toString("errors-only"));
    const read = (name) =>
      fs.readFileSync(path.join(directory, "output", name), "utf8");
    const version = JSON.parse(read("version.json")).version;
    const document = read("index.html");
    assert.match(version, /^[a-f0-9]{20}$/);
    assert.equal(
      document.match(/<meta name="app-version" content="([^"]+)"/)[1],
      version,
    );
    const bundle = document.match(/src="\/(bundle\.[a-f0-9]+\.js)"/)[1];
    const window = {};
    vm.runInNewContext(read(bundle), { window });
    const styleUrl = window.releaseFixture.style;
    assert.match(styleUrl, /^\/style\.[a-f0-9]+\.json$/);
    assert.equal(
      read(styleUrl.slice(1)),
      fs.readFileSync(path.join(directory, "BUILD/style.json"), "utf8"),
    );
    return { version, bundle, styleUrl };
  };
  try {
    fs.mkdirSync(path.join(directory, "public"));
    fs.mkdirSync(path.join(directory, "BUILD"));
    write("public/index.html", html);
    write(
      "public/privacy.html",
      "<!doctype html><html><head></head><body>Privacy</body></html>",
    );
    write("entry.js", entry);
    write("BUILD/style.json", style);
    const baseline = await build();
    assert.deepEqual(
      await build(),
      baseline,
      "Identical builds must retain their version and asset URLs",
    );

    write(
      "public/index.html",
      html.replace(
        "</head>",
        "<meta name=release-test content=changed></head>",
      ),
    );
    const htmlChange = await build();
    assert.notEqual(
      htmlChange.version,
      baseline.version,
      "HTML change did not change the version",
    );
    assert.equal(htmlChange.bundle, baseline.bundle);
    write("public/index.html", html);

    write("entry.js", entry.replace("value: 1", "value: 2"));
    const jsChange = await build();
    assert.notEqual(
      jsChange.version,
      baseline.version,
      "JS change did not change the version",
    );
    assert.notEqual(jsChange.bundle, baseline.bundle);
    assert.equal(jsChange.styleUrl, baseline.styleUrl);
    write("entry.js", entry);

    write(
      "BUILD/style.json",
      JSON.stringify({ ...JSON.parse(style), name: "changed" }),
    );
    const styleChange = await build();
    assert.notEqual(
      styleChange.version,
      baseline.version,
      "Style change did not change the version",
    );
    assert.notEqual(styleChange.bundle, baseline.bundle);
    assert.notEqual(styleChange.styleUrl, baseline.styleUrl);
    console.log(
      "Release build contract passed: matching HTML/manifest, reproducible versions and HTML/JS/style invalidation.",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
