import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"

import { build } from "esbuild"

const output = path.resolve(process.argv[2] ?? "dist/xcode-mcp-broker.bundle.mjs")
const packageJson = JSON.parse(await readFile("package.json", "utf8"))
await mkdir(path.dirname(output), { recursive: true })
await build({
  entryPoints: ["src/cli.mjs"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  define: {
    __XCODE_MCP_BROKER_VERSION__: JSON.stringify(packageJson.version),
  },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  legalComments: "none",
  sourcemap: false,
})
console.log(output)
