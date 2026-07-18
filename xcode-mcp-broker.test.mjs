import assert from "node:assert/strict"
import test from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { runningXcodeProcesses, startHttpBroker, ToolBroker } from "./xcode-mcp-broker.mjs"

const quietLogger = { error() {} }

class FakeDownstream {
  constructor() {
    this.connected = true
    this.listCount = 0
    this.activeCalls = 0
    this.maximumActiveCalls = 0
  }

  async listTools() {
    this.listCount += 1
    return {
      tools: [
        { name: "FirstTool", inputSchema: { type: "object" } },
        { name: "SecondTool", inputSchema: { type: "object" } },
      ],
    }
  }

  async callTool(params, options) {
    this.activeCalls += 1
    this.maximumActiveCalls = Math.max(this.maximumActiveCalls, this.activeCalls)
    options.onprogress?.({ progress: 1, total: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    this.activeCalls -= 1
    return { content: [{ type: "text", text: params.name }] }
  }

  async close() {}
}

test("finds the bridge bundled with the newest running Xcode", () => {
  const processes = runningXcodeProcesses(`
  900 Fri Jul 17 09:15:00 2026 /Applications/Xcode.app/Contents/MacOS/Xcode
  100 Sat Jul 18 17:05:00 2026 /Applications/Xcode 27.app/Contents/MacOS/Xcode
  101 Sat Jul 18 17:05:01 2026 /Applications/Xcode 27.app/Contents/SharedFrameworks/Worker
`)

  assert.deepEqual(processes, [
    {
      pid: 100,
      startedAt: Date.parse("Sat Jul 18 17:05:00 2026"),
      appPath: "/Applications/Xcode 27.app",
      bridgePath: "/Applications/Xcode 27.app/Contents/Developer/usr/bin/mcpbridge",
    },
    {
      pid: 900,
      startedAt: Date.parse("Fri Jul 17 09:15:00 2026"),
      appPath: "/Applications/Xcode.app",
      bridgePath: "/Applications/Xcode.app/Contents/Developer/usr/bin/mcpbridge",
    },
  ])
})

test("caches the downstream tool list", async () => {
  const downstream = new FakeDownstream()
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()

  const first = await broker.listTools()
  const second = await broker.listTools()

  assert.deepEqual(second, first)
  assert.equal(downstream.listCount, 1)
})

test("serves an empty list instead of blocking clients during initial discovery", async () => {
  const downstream = new FakeDownstream()
  let releaseDiscovery
  const discoveryGate = new Promise(resolve => {
    releaseDiscovery = resolve
  })
  const originalListTools = downstream.listTools.bind(downstream)
  downstream.listTools = async () => {
    await discoveryGate
    return originalListTools()
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })

  const startup = broker.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await broker.listTools(), { tools: [] })
  releaseDiscovery()
  await startup
  assert.equal((await broker.listTools()).tools.length, 2)
})

test("recovers tool discovery when Xcode becomes available after startup", async () => {
  const downstream = new FakeDownstream()
  const originalListTools = downstream.listTools.bind(downstream)
  let xcodeAvailable = false
  downstream.connected = false
  downstream.listTools = async () => {
    if (!xcodeAvailable) throw new Error("Xcode is not running")
    return originalListTools()
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })

  await assert.rejects(broker.start(), /Xcode is not running/)
  assert.deepEqual(await broker.listTools(), { tools: [] })

  xcodeAvailable = true
  downstream.connected = true
  downstream.onReconnected()
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal((await broker.listTools()).tools.length, 2)
  assert.equal(broker.health().status, "ok")
  await broker.close()
})

test("serializes simultaneous downstream calls", async () => {
  const downstream = new FakeDownstream()
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()

  await Promise.all([
    broker.callTool({ name: "FirstTool", arguments: {} }),
    broker.callTool({ name: "SecondTool", arguments: {} }),
  ])

  assert.equal(downstream.maximumActiveCalls, 1)
})

test("filters tools and rejects calls outside the allowlist", async () => {
  const downstream = new FakeDownstream()
  const broker = new ToolBroker(downstream, {
    allowedTools: new Set(["FirstTool"]),
    logger: quietLogger,
  })
  await broker.start()

  const result = await broker.listTools()
  assert.deepEqual(result.tools.map(tool => tool.name), ["FirstTool"])
  await assert.rejects(
    broker.callTool({ name: "SecondTool", arguments: {} }),
    /not advertised or allowed/,
  )
})

test("passes progress and cancellation options downstream", async () => {
  const downstream = new FakeDownstream()
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()
  const controller = new AbortController()
  const progress = []

  await broker.callTool(
    { name: "FirstTool", arguments: {} },
    { signal: controller.signal, onprogress: value => progress.push(value) },
  )

  assert.deepEqual(progress, [{ progress: 1, total: 1 }])
})

test("recycles the downstream connection before releasing a cancelled call", async () => {
  const downstream = new FakeDownstream()
  downstream.recycleCount = 0
  downstream.callTool = (_params, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
  })
  downstream.recycle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    downstream.recycleCount += 1
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()
  const controller = new AbortController()

  const call = broker.callTool(
    { name: "FirstTool", arguments: {} },
    { signal: controller.signal },
  )
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error("cancelled"))

  await assert.rejects(call, /cancelled/)
  assert.equal(downstream.recycleCount, 1)
})

test("serves tools through a stateful Streamable HTTP session", async () => {
  const downstream = new FakeDownstream()
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()
  const httpBroker = await startHttpBroker({ broker, port: 0, logger: quietLogger })
  const address = httpBroker.listener.address()
  assert(address && typeof address === "object")

  const client = new Client({ name: "broker-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`))
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(tool => tool.name), ["FirstTool", "SecondTool"])

    const result = await client.callTool({ name: "FirstTool", arguments: {} })
    assert.equal(result.content[0].text, "FirstTool")
  } finally {
    await transport.terminateSession().catch(() => undefined)
    await client.close()
    assert.equal(httpBroker.sessions.size, 0)
    await httpBroker.close()
  }
})
