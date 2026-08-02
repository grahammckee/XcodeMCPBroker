import { main } from "./broker.mjs"
import { uninstallStandalone } from "./uninstall.mjs"
import { brokerVersion } from "./version.mjs"

const command = process.argv[2]

try {
  if (command === "--version" || command === "version") {
    console.log(brokerVersion)
  } else if (command === "uninstall" || command === "--uninstall") {
    await uninstallStandalone()
  } else if (command === "--help" || command === "help") {
    console.log("Usage: xcode-mcp-broker [--version|uninstall]")
  } else {
    await main()
  }
} catch (error) {
  console.error(`[broker] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
