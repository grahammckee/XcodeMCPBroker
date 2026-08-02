import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export const brokerVersion = typeof __XCODE_MCP_BROKER_VERSION__ === "string"
  ? __XCODE_MCP_BROKER_VERSION__
  : require("../package.json").version
