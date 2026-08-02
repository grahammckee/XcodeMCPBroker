import { execFile } from "node:child_process"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const label = "com.gmicc.opencode-xcode-mcp-broker"

export async function uninstallStandalone({ home = homedir(), uid = process.getuid(), logger = console } = {}) {
  const domain = `gui/${uid}`
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`)
  const applicationDirectory = path.join(home, "Library", "Application Support", "XcodeMCPBroker")

  await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => undefined)
  await rm(plistPath, { force: true })
  await rm(applicationDirectory, { force: true, recursive: true })
  logger.log(`Removed ${label}; logs were retained in ~/Library/Logs`)
}
