import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const label = "com.gmicc.opencode-xcode-mcp-broker"
const domain = `gui/${process.getuid()}`
const brokerDirectory = path.dirname(fileURLToPath(import.meta.url))
const launchAgentsDirectory = path.join(homedir(), "Library", "LaunchAgents")
const logsDirectory = path.join(homedir(), "Library", "Logs")
const plistPath = path.join(launchAgentsDirectory, `${label}.plist`)
const logPath = path.join(logsDirectory, "xcode-mcp-broker.log")
const environmentVariableNames = [
  "XCODE_MCP_ALLOWED_TOOLS",
  "XCODE_MCP_BRIDGE_COMMAND",
  "XCODE_MCP_BROKER_HOST",
  "XCODE_MCP_BROKER_PORT",
  "XCODE_MCP_REQUEST_TIMEOUT_MS",
  "XCODE_MCP_SESSION_IDLE_TIMEOUT_MS",
]

function escapeXML(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

async function findNodeExecutable() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, "node")
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return process.execPath
}

async function bootout() {
  await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => undefined)
}

async function bootstrap() {
  let lastError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await execFileAsync("/bin/launchctl", ["bootstrap", domain, plistPath])
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
  }
  throw lastError
}

if (process.argv.includes("--uninstall")) {
  await bootout()
  await rm(plistPath, { force: true })
  console.log(`Removed ${label}`)
  process.exit(0)
}

const environmentEntries = environmentVariableNames
  .filter(name => process.env[name] !== undefined)
  .map(name => `        <key>${name}</key>\n        <string>${escapeXML(process.env[name])}</string>`)
  .join("\n")
const environmentVariables = environmentEntries
  ? `    <key>EnvironmentVariables</key>\n    <dict>\n${environmentEntries}\n    </dict>\n`
  : ""
const nodeExecutable = await findNodeExecutable()

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXML(nodeExecutable)}</string>
        <string>${escapeXML(path.join(brokerDirectory, "xcode-mcp-broker.mjs"))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXML(brokerDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
${environmentVariables}    <key>StandardOutPath</key>
    <string>${escapeXML(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXML(logPath)}</string>
</dict>
</plist>
`

await mkdir(launchAgentsDirectory, { recursive: true })
await mkdir(logsDirectory, { recursive: true })
await bootout()
await writeFile(plistPath, plist, "utf8")
await bootstrap()

console.log(`Installed ${label}`)
console.log("MCP endpoint: http://127.0.0.1:7341/mcp")
console.log(`Log: ${logPath}`)
