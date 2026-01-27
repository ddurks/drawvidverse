const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const handlers = ["connect", "default", "disconnect", "message"];
const outdir = path.join(__dirname, "dist", "lambda-bundle");

// Ensure output directory exists
fs.mkdirSync(outdir, { recursive: true });

// Bundle each handler
Promise.all(
  handlers.map((handler) => {
    return esbuild.build({
      entryPoints: [path.join(__dirname, "src", "lambdas", `${handler}.ts`)],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      outfile: path.join(outdir, `${handler}.js`),
      external: [],
      sourcemap: false,
    });
  }),
)
  .then(() => {
    console.log("✓ Lambda bundling complete");
  })
  .catch((err) => {
    console.error("✗ Lambda bundling failed:", err);
    process.exit(1);
  });
