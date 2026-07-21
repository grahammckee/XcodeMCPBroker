import assert from "node:assert/strict"
import test from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"

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

test("forwards progress without coupling active work to upstream cancellation", async () => {
  const downstream = new FakeDownstream()
  let releaseFirstCall
  const firstCallGate = new Promise(resolve => {
    releaseFirstCall = resolve
  })
  let firstCallStarted
  const started = new Promise(resolve => {
    firstCallStarted = resolve
  })
  const calls = []
  downstream.callTool = async (params, options) => {
    calls.push(params.name)
    assert.equal(options.signal, undefined)
    options.onprogress?.({ progress: 1, total: 1 })
    if (params.name === "FirstTool") {
      firstCallStarted()
      await firstCallGate
    }
    return { content: [{ type: "text", text: params.name }] }
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()
  const controller = new AbortController()
  const progress = []

  const firstCall = broker.callTool(
    { name: "FirstTool", arguments: {} },
    { signal: controller.signal, onprogress: value => progress.push(value) },
  )
  await started
  controller.abort(new Error("cancelled"))
  const secondCall = broker.callTool({ name: "SecondTool", arguments: {} })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(calls, ["FirstTool"])
  releaseFirstCall()
  await Promise.all([firstCall, secondCall])

  assert.deepEqual(progress, [{ progress: 1, total: 1 }])
  assert.deepEqual(calls, ["FirstTool", "SecondTool"])
})

test("drops a cancelled queued call without dispatching it downstream", async () => {
  const downstream = new FakeDownstream()
  let releaseFirstCall
  const firstCallGate = new Promise(resolve => {
    releaseFirstCall = resolve
  })
  const calls = []
  downstream.callTool = async params => {
    calls.push(params.name)
    if (params.name === "FirstTool") await firstCallGate
    return { content: [{ type: "text", text: params.name }] }
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()
  const controller = new AbortController()

  const firstCall = broker.callTool({ name: "FirstTool", arguments: {} })
  const cancelledCall = broker.callTool(
    { name: "SecondTool", arguments: {} },
    { signal: controller.signal },
  )
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error("cancelled"))
  releaseFirstCall()

  await firstCall
  await assert.rejects(cancelledCall, /cancelled/)
  assert.deepEqual(calls, ["FirstTool"])
})

test("does not replace the downstream connection after a request timeout", async () => {
  const downstream = new FakeDownstream()
  downstream.recycleCount = 0
  downstream.recycle = async () => {
    downstream.recycleCount += 1
  }
  downstream.callTool = async () => {
    throw new McpError(ErrorCode.RequestTimeout, "Request timed out")
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()

  await assert.rejects(
    broker.callTool({ name: "FirstTool", arguments: {} }),
    /Request timed out/,
  )
  assert.equal(downstream.recycleCount, 0)
})

test("keeps one downstream connection when an HTTP client cancels", async () => {
  const downstream = new FakeDownstream()
  let releaseFirstCall
  const firstCallGate = new Promise(resolve => {
    releaseFirstCall = resolve
  })
  let firstCallStarted
  const started = new Promise(resolve => {
    firstCallStarted = resolve
  })
  const calls = []
  downstream.callTool = async params => {
    calls.push(params.name)
    if (params.name === "FirstTool") {
      firstCallStarted()
      await firstCallGate
    }
    return { content: [{ type: "text", text: params.name }] }
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()
  const httpBroker = await startHttpBroker({ broker, port: 0, logger: quietLogger })
  const address = httpBroker.listener.address()
  assert(address && typeof address === "object")
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`)
  const firstTransport = new StreamableHTTPClientTransport(url)
  const secondTransport = new StreamableHTTPClientTransport(url)
  const firstClient = new Client({ name: "first-client", version: "1.0.0" })
  const secondClient = new Client({ name: "second-client", version: "1.0.0" })

  try {
    await Promise.all([
      firstClient.connect(firstTransport),
      secondClient.connect(secondTransport),
    ])
    const controller = new AbortController()
    const cancelledCall = firstClient.callTool(
      { name: "FirstTool", arguments: {} },
      undefined,
      { signal: controller.signal },
    )
    await started
    const secondCall = secondClient.callTool({ name: "SecondTool", arguments: {} })
    controller.abort(new Error("cancelled"))
    await assert.rejects(cancelledCall, /cancelled/)
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(calls, ["FirstTool"])
    releaseFirstCall()
    const result = await secondCall
    assert.equal(result.content[0].text, "SecondTool")
    assert.deepEqual(calls, ["FirstTool", "SecondTool"])
  } finally {
    releaseFirstCall()
    await Promise.allSettled([
      firstTransport.terminateSession(),
      secondTransport.terminateSession(),
    ])
    await Promise.allSettled([firstClient.close(), secondClient.close()])
    await httpBroker.close()
  }
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
