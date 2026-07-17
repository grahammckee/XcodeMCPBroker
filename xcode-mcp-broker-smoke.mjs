import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const url = new URL(process.env.XCODE_MCP_BROKER_URL ?? "http://127.0.0.1:7341/mcp")
const timeout = Number(process.env.XCODE_MCP_SMOKE_TIMEOUT_MS ?? 60_000)
const client = new Client({ name: "xcode-mcp-broker-smoke", version: "1.0.0" })
const transport = new StreamableHTTPClientTransport(url)

try {
  await client.connect(transport)
  const deadline = Date.now() + timeout
  let result
  do {
    result = await client.listTools()
    if (result.tools.some(tool => tool.name === "XcodeListWindows")) break
    await new Promise(resolve => setTimeout(resolve, 500))
  } while (Date.now() < deadline)
  if (!result.tools.some(tool => tool.name === "XcodeListWindows")) {
    throw new Error(`Broker did not advertise XcodeListWindows within ${timeout}ms`)
  }
  const call = await client.callTool({ name: "XcodeListWindows", arguments: {} })
  if (call.isError) throw new Error(`XcodeListWindows failed: ${JSON.stringify(call.content)}`)
  console.log(JSON.stringify({ toolCount: result.tools.length, xcodeListWindows: "ok" }))
} finally {
  await transport.terminateSession().catch(() => undefined)
  await client.close()
}
