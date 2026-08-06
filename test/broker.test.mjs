import assert from "node:assert/strict"
import test from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"

import { runningXcodeProcesses, startHttpBroker, ToolBroker, XcodeDownstream } from "../src/broker.mjs"

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

class FakeMcpClient {
  constructor() {
    this.listTimeouts = []
    this.closed = false
  }

  setNotificationHandler() {}
  async connect() {}

  async listTools(_params, options) {
    this.listTimeouts.push(options.timeout)
    return { tools: [] }
  }

  async close() {
    this.closed = true
    this.onclose?.()
  }
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

test("gives initial discovery time to receive Xcode authorization", async () => {
  const client = new FakeMcpClient()
  const downstream = new XcodeDownstream({
    command: "/fake/mcpbridge",
    discoveryTimeout: 10,
    maximumRequestDuration: 1_234,
    clientFactory: () => client,
    transportFactory: () => ({}),
    logger: quietLogger,
  })

  await downstream.listTools()
  await downstream.listTools()

  assert.deepEqual(client.listTimeouts, [1_234, 10])
  await downstream.close()
})

test("replaces a stale bridge once when its pinned Xcode process exits", async () => {
  let currentPid = 100
  const runningPids = new Set([currentPid])
  const clients = []
  const connectedPids = []
  const downstream = new XcodeDownstream({
    xcodeStartupGrace: 0,
    xcodeMonitorInterval: 5,
    findRunningXcode: async () => ({
      pid: currentPid,
      startedAt: 0,
      bridgePath: "/fake/mcpbridge",
    }),
    isProcessRunning: pid => runningPids.has(pid),
    clientFactory: () => {
      const client = new FakeMcpClient()
      clients.push(client)
      return client
    },
    transportFactory: parameters => {
      connectedPids.push(parameters.xcodePid)
      return {}
    },
    logger: quietLogger,
  })

  await downstream.listTools()
  runningPids.delete(currentPid)
  currentPid = 200
  runningPids.add(currentPid)

  const deadline = Date.now() + 500
  while (clients.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  assert.deepEqual(connectedPids, [100, 200])
  assert.equal(clients[0].closed, true)
  assert.equal(clients.length, 2)
  await downstream.close()
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

test("stops advertising cached tools when Xcode disconnects", async () => {
  const downstream = new FakeDownstream()
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()
  assert.equal((await broker.listTools()).tools.length, 2)

  downstream.connected = false
  downstream.onDisconnected()

  assert.deepEqual(await broker.listTools(), { tools: [] })
  assert.equal(broker.health().cachedToolCount, 0)
  assert.equal(broker.health().status, "degraded")
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

test("cancels active downstream work and releases the queue", async () => {
  const downstream = new FakeDownstream()
  let firstCallStarted
  const started = new Promise(resolve => {
    firstCallStarted = resolve
  })
  const calls = []
  downstream.callTool = async (params, options) => {
    calls.push(params.name)
    options.onprogress?.({ progress: 1, total: 1 })
    if (params.name === "FirstTool") {
      firstCallStarted()
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
      })
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
  assert.deepEqual(calls, ["FirstTool"])
  const firstCallCancelled = assert.rejects(firstCall, /cancelled/)
  controller.abort(new Error("cancelled"))
  const secondCall = broker.callTool({ name: "SecondTool", arguments: {} })

  await firstCallCancelled
  const result = await secondCall

  assert.deepEqual(progress, [{ progress: 1, total: 1 }])
  assert.deepEqual(calls, ["FirstTool", "SecondTool"])
  assert.equal(result.content[0].text, "SecondTool")
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

test("keeps the downstream connection after a request timeout", async () => {
  const downstream = new FakeDownstream()
  downstream.recycleCount = 0
  downstream.recycle = async () => {
    downstream.recycleCount += 1
  }
  let callCount = 0
  downstream.callTool = async params => {
    callCount += 1
    if (callCount === 1) throw new McpError(ErrorCode.RequestTimeout, "Request timed out")
    return { content: [{ type: "text", text: params.name }] }
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()

  const timedOutCall = broker.callTool({ name: "FirstTool", arguments: {} })
  const queuedCall = broker.callTool({ name: "SecondTool", arguments: {} })

  await assert.rejects(
    timedOutCall,
    /Retry this tool call\. Do not restart, stop, or kill the shared broker/,
  )
  assert.equal(downstream.recycleCount, 0)

  const result = await queuedCall
  assert.equal(result.content[0].text, "SecondTool")
  assert.equal(downstream.recycleCount, 0)
})

test("keeps the downstream connection after tool discovery times out", async () => {
  const downstream = new FakeDownstream()
  const originalListTools = downstream.listTools.bind(downstream)
  let discoveryCount = 0
  downstream.recycleCount = 0
  downstream.recycle = async () => {
    downstream.recycleCount += 1
  }
  downstream.listTools = async () => {
    discoveryCount += 1
    if (discoveryCount === 1) throw new McpError(ErrorCode.RequestTimeout, "Request timed out")
    return originalListTools()
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })

  await assert.rejects(
    broker.start(),
    /Retry this tool call\. Do not restart, stop, or kill the shared broker/,
  )
  assert.equal(downstream.recycleCount, 0)
  assert.equal(broker.health().status, "degraded")
  assert.deepEqual(await broker.listTools(), { tools: [] })

  await broker.refreshToolCache()
  assert.equal(broker.health().status, "ok")
  assert.equal((await broker.listTools()).tools.length, 2)
})

test("recovers the downstream after a definitive connection closure", async () => {
  const downstream = new FakeDownstream()
  downstream.recycleCount = 0
  downstream.recycle = async () => {
    downstream.recycleCount += 1
  }
  let callCount = 0
  downstream.callTool = async params => {
    callCount += 1
    if (callCount === 1) throw new McpError(ErrorCode.ConnectionClosed, "Connection closed")
    return { content: [{ type: "text", text: params.name }] }
  }
  const broker = new ToolBroker(downstream, { logger: quietLogger })
  await broker.start()

  await assert.rejects(
    broker.callTool({ name: "FirstTool", arguments: {} }),
    /shared Xcode connection closed and is recovering.*Do not restart, stop, or kill the broker/,
  )
  assert.equal(downstream.recycleCount, 1)
  assert.deepEqual(await broker.listTools(), { tools: [] })

  await broker.refreshToolCache()
  const result = await broker.callTool({ name: "SecondTool", arguments: {} })
  assert.equal(result.content[0].text, "SecondTool")
  assert.equal(downstream.recycleCount, 1)
})

test("releases active HTTP work without recycling when a client cancels", async () => {
  const downstream = new FakeDownstream()
  downstream.recycleCount = 0
  downstream.recycle = async () => {
    downstream.recycleCount += 1
  }
  let firstCallStarted
  const started = new Promise(resolve => {
    firstCallStarted = resolve
  })
  const calls = []
  downstream.callTool = async (params, options) => {
    calls.push(params.name)
    if (params.name === "FirstTool") {
      firstCallStarted()
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
      })
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
    const result = await secondCall
    assert.equal(result.content[0].text, "SecondTool")
    assert.deepEqual(calls, ["FirstTool", "SecondTool"])
    assert.equal(downstream.recycleCount, 0)
  } finally {
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
