import { execFileSync } from "node:child_process"
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const runtimeInput = path.resolve(process.argv[2] ?? "dist/xcode-mcp-broker")
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

  const runtimeDirectory = path.join(applicationDirectory, "runtime")
  if ((await stat(runtimeInput)).isDirectory()) {
    await cp(runtimeInput, runtimeDirectory, { recursive: true })
  } else {
    const armDirectory = path.join(runtimeDirectory, "arm64")
    await mkdir(armDirectory, { recursive: true })
    await copyFile(runtimeInput, path.join(armDirectory, "xcode-mcp-broker"))
  }

  const armExecutable = path.join(runtimeDirectory, "arm64", "xcode-mcp-broker")
  const intelNode = path.join(runtimeDirectory, "x86_64", "node")
  const intelBundle = path.join(runtimeDirectory, "xcode-mcp-broker.bundle.mjs")
  const nodeLicense = path.join(runtimeDirectory, "LICENSE.node")
  const architectures = []
  if (await access(armExecutable).then(() => true, () => false)) {
    await chmod(armExecutable, 0o755)
    architectures.push("arm64")
  }
  const hasIntelNode = await access(intelNode).then(() => true, () => false)
  const hasIntelBundle = await access(intelBundle).then(() => true, () => false)
  const hasNodeLicense = await access(nodeLicense).then(() => true, () => false)
  if (hasIntelNode !== hasIntelBundle) throw new Error("Intel runtime requires both node and xcode-mcp-broker.bundle.mjs")
  if (hasIntelNode && !hasNodeLicense) throw new Error("Intel runtime requires the Node.js license")
  if (hasIntelNode) {
    await chmod(intelNode, 0o755)
    architectures.push("x86_64")
  }
  if (architectures.length === 0) throw new Error("Runtime input does not contain a supported macOS runtime")

  const launcher = `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -m)" in
  arm64)
    exec "$ROOT/runtime/arm64/xcode-mcp-broker" "$@"
    ;;
  x86_64)
    exec "$ROOT/runtime/x86_64/node" "$ROOT/runtime/xcode-mcp-broker.bundle.mjs" "$@"
    ;;
  *)
    echo "Unsupported Mac architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
`
  const launcherPath = path.join(applicationDirectory, "xcode-mcp-broker")
  await writeFile(launcherPath, launcher, { mode: 0o755 })

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
    <options customize="never" require-scripts="false" hostArchitectures="${architectures.join(",")}"/>
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
