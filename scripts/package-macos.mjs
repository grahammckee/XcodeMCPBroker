import { execFileSync } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const binary = path.resolve(process.argv[2] ?? "dist/xcode-mcp-broker")
const output = path.resolve(process.argv[3] ?? "dist/XcodeMCPBroker.pkg")
const installerIdentity = process.env.APPLE_INSTALLER_IDENTITY
const keychain = process.env.APPLE_SIGNING_KEYCHAIN
const packageJson = JSON.parse(await readFile("package.json", "utf8"))
const identifier = "com.gmicc.opencode-xcode-mcp-broker"
const work = await mkdtemp(path.join(tmpdir(), "xcode-mcp-broker-pkg-"))

const escapeXML = value => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")

try {
  const payload = path.join(work, "payload")
  const applicationDirectory = path.join(payload, "Library", "Application Support", "XcodeMCPBroker")
  const launchAgentsDirectory = path.join(payload, "Library", "LaunchAgents")
  await mkdir(applicationDirectory, { recursive: true })
  await mkdir(launchAgentsDirectory, { recursive: true })
  await copyFile(binary, path.join(applicationDirectory, "xcode-mcp-broker"))
  await chmod(path.join(applicationDirectory, "xcode-mcp-broker"), 0o755)

  const command = 'exec "$HOME/Library/Application Support/XcodeMCPBroker/xcode-mcp-broker" >> "$HOME/Library/Logs/xcode-mcp-broker.log" 2>&1'
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${identifier}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${escapeXML(command)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`
  await writeFile(path.join(launchAgentsDirectory, `${identifier}.plist`), plist, { mode: 0o644 })

  const componentPackage = path.join(work, "XcodeMCPBroker-component.pkg")
  execFileSync("pkgbuild", [
    "--root", payload,
    "--identifier", `${identifier}.payload`,
    "--version", packageJson.version,
    "--install-location", "/",
    componentPackage,
  ], { stdio: "inherit" })

  const distribution = `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Xcode MCP Broker ${packageJson.version}</title>
    <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
    <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
    <choices-outline>
        <line choice="default"/>
    </choices-outline>
    <choice id="default" visible="false">
        <pkg-ref id="${identifier}.payload"/>
    </choice>
    <pkg-ref id="${identifier}.payload" version="${packageJson.version}">${path.basename(componentPackage)}</pkg-ref>
</installer-gui-script>
`
  const distributionPath = path.join(work, "Distribution.xml")
  await writeFile(distributionPath, distribution)
  await mkdir(path.dirname(output), { recursive: true })

  const productArguments = ["--distribution", distributionPath, "--package-path", work]
  if (installerIdentity) productArguments.push("--sign", installerIdentity, "--timestamp")
  if (keychain) productArguments.push("--keychain", keychain)
  productArguments.push(output)
  execFileSync("productbuild", productArguments, { stdio: "inherit" })
  console.log(output)
} finally {
  await rm(work, { recursive: true, force: true })
}
