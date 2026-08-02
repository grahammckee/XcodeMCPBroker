import { execFileSync } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const major = Number(process.versions.node.split(".")[0])
if (major < 26) throw new Error("Building the standalone executable requires Node.js 26 or later")

const bundle = path.resolve(process.argv[2] ?? "dist/xcode-mcp-broker.bundle.mjs")
const output = path.resolve(process.argv[3] ?? "dist/xcode-mcp-broker")
const configPath = path.resolve("dist/sea-config.json")
await mkdir(path.dirname(output), { recursive: true })
await writeFile(configPath, `${JSON.stringify({
  main: bundle,
  mainFormat: "module",
  output,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgvExtension: "none",
}, null, 2)}\n`)
execFileSync(process.execPath, ["--build-sea", configPath], { stdio: "inherit" })
await chmod(output, 0o755)
console.log(output)
