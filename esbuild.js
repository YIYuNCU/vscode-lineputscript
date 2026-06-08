const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  legalComments: "none",
  logLevel: "info"
};

const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "out/src/extension.js"
  },
  {
    ...common,
    entryPoints: ["src/server.ts"],
    outfile: "out/src/server.js"
  }
];

const testBuilds = fs.existsSync("test")
  ? fs.readdirSync("test")
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => ({
      ...common,
      entryPoints: [path.join("test", file)],
      outfile: path.join("out", "test", file.replace(/\.ts$/, ".js")),
      external: ["vscode"],
      minify: false,
      sourcemap: false
    }))
  : [];

async function run() {
  if (tests) {
    await Promise.all(testBuilds.map((options) => esbuild.build(options)));
    return;
  }

  if (watch) {
    const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
    console.log("Watching LinePutScript extension sources...");
    return;
  }

  await Promise.all(builds.map((options) => esbuild.build(options)));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
