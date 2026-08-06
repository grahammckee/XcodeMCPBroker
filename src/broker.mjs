import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"

import { brokerVersion } from "./version.mjs"

const defaultHost = "127.0.0.1"
const defaultPort = 7341
const defaultRequestTimeout = 45 * 1000
const defaultDiscoveryTimeout = 10 * 1000
const defaultMaximumRequestDuration = 30 * 60 * 1000
const defaultXcodeStartupGrace = 5 * 1000
const defaultXcodeMonitorInterval = 1 * 1000
const execFileAsync = promisify(execFile)

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function retryableError(error) {
  if (!(error instanceof McpError)) return error
  if (error.code === ErrorCode.RequestTimeout) {
    return new McpError(
      error.code,
      "Xcode did not respond in time. Retry this tool call. Do not restart, stop, or kill the shared broker; other agents may be using it.",
      error.data,
    )
  }
  if (error.code === ErrorCode.ConnectionClosed) {
    return new McpError(
      error.code,
      "The shared Xcode connection closed and is recovering. Retry shortly. Do not restart, stop, or kill the broker.",
      error.data,
    )
  }
  return error
}

export function runningXcodeProcesses(processList) {
  return processList
    .split("\n")
    .flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?\.app\/Contents\/MacOS\/Xcode)(?:\s.*)?$/)
      if (!match) return []
      const startedAt = Date.parse(match[2])
      if (!Number.isFinite(startedAt)) return []
      const appPathEnd = match[3].indexOf(".app/") + 4
      const appPath = match[3].slice(0, appPathEnd)
      return [{
        pid: Number(match[1]),
        startedAt,
        appPath,
        bridgePath: path.join(appPath, "Contents", "Developer", "usr", "bin", "mcpbridge"),
      }]
    })
    .sort((left, right) => right.startedAt - left.startedAt || right.pid - left.pid)
}

async function runningXcodeBridge() {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,lstart=,command="],
    { env: { ...getDefaultEnvironment(), LC_ALL: "C" } },
  )
  for (const candidate of runningXcodeProcesses(stdout)) {
    try {
      await access(candidate.bridgePath, constants.X_OK)
      return candidate
    } catch {
      // Try another running Xcode installation.
    }
  }
  return undefined
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

export class SerialExecutor {
  #tail = Promise.resolve()
  #active = false
  #queued = 0

  get active() {
    return this.#active
  }

  get queued() {
    return this.#queued
  }

  run(operation, signal) {
    this.#queued += 1
    const result = this.#tail.then(async () => {
      this.#queued -= 1
      signal?.throwIfAborted()
      this.#active = true
      try {
        return await operation()
      } finally {
        this.#active = false
      }
    })
    this.#tail = result.catch(() => undefined)
    return result
  }
}

export class XcodeDownstream {
  #client = null
  #connecting = null
  #reconnectTimer = null
  #reconnectDelay = 250
  #hasAttemptedConnection = false
  #closed = false
  #recycling = null
  #hasReceivedToolList = false
  #xcodePid = null
  #xcodeMonitorTimer = null

  constructor({
    command = process.env.XCODE_MCP_BRIDGE_COMMAND,
    args,
    requestTimeout = Number(process.env.XCODE_MCP_REQUEST_TIMEOUT_MS ?? defaultRequestTimeout),
    discoveryTimeout = Number(process.env.XCODE_MCP_DISCOVERY_TIMEOUT_MS ?? defaultDiscoveryTimeout),
    maximumRequestDuration = Number(process.env.XCODE_MCP_MAX_TOTAL_TIMEOUT_MS ?? defaultMaximumRequestDuration),
    xcodeStartupGrace = Number(process.env.XCODE_MCP_XCODE_STARTUP_GRACE_MS ?? defaultXcodeStartupGrace),
    xcodeMonitorInterval = defaultXcodeMonitorInterval,
    findRunningXcode = runningXcodeBridge,
    isProcessRunning = processExists,
    clientFactory = () => new Client({ name: "xcode-mcp-broker", version: brokerVersion }),
    transportFactory = parameters => new StdioClientTransport(parameters),
    logger = console,
  } = {}) {
    this.command = command
    this.args = args
    this.requestTimeout = requestTimeout
    this.discoveryTimeout = discoveryTimeout
    this.maximumRequestDuration = maximumRequestDuration
    this.xcodeStartupGrace = xcodeStartupGrace
    this.xcodeMonitorInterval = xcodeMonitorInterval
    this.findRunningXcode = findRunningXcode
    this.isProcessRunning = isProcessRunning
    this.clientFactory = clientFactory
    this.transportFactory = transportFactory
    this.logger = logger
    this.onReconnected = undefined
    this.onDisconnected = undefined
    this.onToolsChanged = undefined
  }

  get connected() {
    return this.#client !== null
  }

  async connect() {
    if (this.#recycling) return this.#recycling
    return this.#ensureConnected()
  }

  async #ensureConnected() {
    if (this.#client) return
    if (this.#connecting) return this.#connecting
    if (this.#closed) throw new Error("Xcode downstream is closed")

    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }

    const isReconnect = this.#hasAttemptedConnection
    this.#hasAttemptedConnection = true
    this.#connecting = this.#connectOnce(isReconnect)
    try {
      await this.#connecting
    } catch (error) {
      this.#scheduleReconnect()
      throw error
    } finally {
      this.#connecting = null
    }
  }

  async #connectOnce(isReconnect) {
    const serverParameters = await this.#serverParameters()
    const client = this.clientFactory()
    const transport = this.transportFactory(serverParameters)

    client.onerror = error => this.logger.error(`[broker] downstream error: ${errorMessage(error)}`)
    client.onclose = () => this.#handleClose(client)
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.onToolsChanged?.()
    })

    try {
      await client.connect(transport)
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }

    if (this.#closed) {
      await client.close().catch(() => undefined)
      throw new Error("Xcode downstream closed while connecting")
    }

    this.#client = client
    this.#hasReceivedToolList = false
    this.#xcodePid = serverParameters.xcodePid ?? null
    this.#startXcodeMonitor()
    this.#reconnectDelay = 250
    const xcodeTarget = serverParameters.xcodePid ? ` for Xcode PID ${serverParameters.xcodePid}` : ""
    this.logger.error(`[broker] connected to ${serverParameters.command} ${(serverParameters.args ?? []).join(" ")}${xcodeTarget}`)
    if (isReconnect) this.onReconnected?.()
  }

  async #serverParameters() {
    if (this.command) {
      return {
        command: this.command,
        args: this.args ?? (path.basename(this.command) === "xcrun" ? ["mcpbridge"] : []),
      }
    }

    while (!this.#closed) {
      const runningXcode = await this.findRunningXcode()
      if (runningXcode) {
        const startupDelay = runningXcode.startedAt + this.xcodeStartupGrace - Date.now()
        if (startupDelay > 0) await new Promise(resolve => setTimeout(resolve, startupDelay))
        return {
          command: runningXcode.bridgePath,
          args: [],
          env: {
            ...getDefaultEnvironment(),
            MCP_XCODE_PID: String(runningXcode.pid),
          },
          xcodePid: runningXcode.pid,
        }
      }
      await new Promise(resolve => setTimeout(resolve, this.xcodeMonitorInterval))
    }
    throw new Error("Xcode downstream closed while waiting for Xcode")
  }

  #startXcodeMonitor() {
    if (this.#xcodePid === null || this.#xcodeMonitorTimer) return
    this.#xcodeMonitorTimer = setInterval(() => {
      if (this.#closed || this.#recycling || this.#xcodePid === null) return
      if (this.isProcessRunning(this.#xcodePid)) return

      const exitedPid = this.#xcodePid
      clearInterval(this.#xcodeMonitorTimer)
      this.#xcodeMonitorTimer = null
      this.logger.error(`[broker] Xcode PID ${exitedPid} exited; reconnecting to the next Xcode process`)
      void this.recycle().catch(error => {
        if (!this.#closed) this.logger.error(`[broker] failed to reconnect after Xcode exited: ${errorMessage(error)}`)
      })
    }, this.xcodeMonitorInterval)
    this.#xcodeMonitorTimer.unref()
  }

  #stopXcodeMonitor() {
    if (this.#xcodeMonitorTimer) clearInterval(this.#xcodeMonitorTimer)
    this.#xcodeMonitorTimer = null
    this.#xcodePid = null
  }

  #handleClose(client) {
    if (this.#client !== client) return
    this.#client = null
    this.#stopXcodeMonitor()
    this.onDisconnected?.()
    if (this.#closed) return
    this.logger.error("[broker] downstream bridge closed; reconnecting")
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.#closed || this.#reconnectTimer) return
    const delay = this.#reconnectDelay
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 10_000)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.connect().catch(error => {
        this.logger.error(`[broker] reconnect failed: ${errorMessage(error)}`)
        this.#scheduleReconnect()
      })
    }, delay)
    this.#reconnectTimer.unref()
  }

  async listTools(params) {
    await this.connect()
    const timeout = this.#hasReceivedToolList ? this.discoveryTimeout : this.maximumRequestDuration
    const result = await this.#client.listTools(params, { timeout })
    this.#hasReceivedToolList = true
    return result
  }

  async callTool(params, options = {}) {
    await this.connect()
    return this.#client.callTool(params, CallToolResultSchema, {
      ...options,
      timeout: this.requestTimeout,
      maxTotalTimeout: this.maximumRequestDuration,
      resetTimeoutOnProgress: true,
    })
  }

  async recycle() {
    if (this.#closed) return
    if (this.#recycling) return this.#recycling

    const client = this.#client
    this.#client = null
    this.#stopXcodeMonitor()
    this.onDisconnected?.()
    this.#recycling = (async () => {
      await client?.close().catch(() => undefined)
      await this.#ensureConnected()
    })()
    try {
      await this.#recycling
    } finally {
      this.#recycling = null
    }
  }

  async close() {
    this.#closed = true
    this.#stopXcodeMonitor()
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    await this.#connecting?.catch(() => undefined)
    const client = this.#client
    this.#client = null
    await client?.close()
  }
}

export class ToolBroker {
  #cache = new Map()
  #advertisedTools = new Set()
  #upstreamServers = new Set()
  #serial = new SerialExecutor()
  #refreshing = null
  #refreshPending = false
  #refreshRetryTimer = null
  #refreshRetryDelay = 1_000
  #initializing = false
  #ready = false
  #lastFailure = null
  #activeTool = null
  #activeSince = null

  constructor(downstream, { allowedTools, logger = console } = {}) {
    this.downstream = downstream
    this.allowedTools = allowedTools
    this.logger = logger
    downstream.onDisconnected = () => this.#markNotReady()
    downstream.onReconnected = () => {
      this.#markNotReady()
      if (!this.#initializing && !this.#refreshing) this.#scheduleRefresh()
    }
    downstream.onToolsChanged = () => this.#scheduleRefresh()
  }

  #markNotReady(error) {
    this.#ready = false
    this.#cache.clear()
    this.#advertisedTools.clear()
    if (error) this.#lastFailure = errorMessage(error)
  }

  async #recoverAfterFailure(error, context) {
    this.#markNotReady(error)
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      this.logger.error(`[broker] ${context} timed out; keeping the shared downstream connection`)
      return
    }
    if (!(error instanceof McpError) || error.code !== ErrorCode.ConnectionClosed) return
    if (typeof this.downstream.recycle !== "function") return
    this.logger.error(`[broker] ${context} lost its connection; recovering the shared downstream`)
    await this.downstream.recycle().catch(recycleError => {
      this.logger.error(`[broker] failed to recover downstream: ${errorMessage(recycleError)}`)
    })
  }

  async start() {
    this.#initializing = true
    try {
      await this.refreshToolCache()
      await this.#notifyToolListChanged()
    } catch (error) {
      this.#scheduleRefreshRetry()
      throw error
    } finally {
      this.#initializing = false
    }
  }

  #scheduleRefreshRetry() {
    if (this.#refreshRetryTimer) return
    const delay = this.#refreshRetryDelay
    this.#refreshRetryDelay = Math.min(this.#refreshRetryDelay * 2, 30_000)
    this.#refreshRetryTimer = setTimeout(() => {
      this.#refreshRetryTimer = null
      this.#scheduleRefresh()
    }, delay)
    this.#refreshRetryTimer.unref()
  }

  #scheduleRefresh() {
    if (this.#refreshing) {
      this.#refreshPending = true
      return
    }
    let failed = false
    this.#refreshing = this.refreshToolCache()
      .then(() => this.#notifyToolListChanged())
      .catch(error => {
        failed = true
        this.logger.error(`[broker] failed to refresh tools: ${errorMessage(error)}`)
      })
      .finally(() => {
        this.#refreshing = null
        if (this.#refreshPending) {
          this.#refreshPending = false
          this.#scheduleRefresh()
        } else if (failed) {
          this.#scheduleRefreshRetry()
        }
      })
  }

  #filterResult(result) {
    if (!this.allowedTools) return result
    return {
      ...result,
      tools: result.tools.filter(tool => this.allowedTools.has(tool.name)),
    }
  }

  async refreshToolCache() {
    return this.#serial.run(async () => {
      this.#activeTool = "tools/list"
      this.#activeSince = Date.now()
      try {
        const cache = new Map()
        const advertisedTools = new Set()
        let cursor

        do {
          const result = this.#filterResult(await this.downstream.listTools(cursor ? { cursor } : undefined))
          cache.set(cursor ?? "", result)
          for (const tool of result.tools) advertisedTools.add(tool.name)
          cursor = result.nextCursor
        } while (cursor)

        this.#cache = cache
        this.#advertisedTools = advertisedTools
        this.#ready = true
        this.#lastFailure = null
        this.#refreshRetryDelay = 1_000
        if (this.#refreshRetryTimer) clearTimeout(this.#refreshRetryTimer)
        this.#refreshRetryTimer = null
        this.logger.error(`[broker] cached ${advertisedTools.size} Xcode tools`)
      } catch (error) {
        await this.#recoverAfterFailure(error, "tool discovery")
        throw retryableError(error)
      } finally {
        this.#activeTool = null
        this.#activeSince = null
      }
    })
  }

  async listTools(params) {
    if (this.#initializing || !this.#ready) return { tools: [] }
    const key = params?.cursor ?? ""
    const cached = this.#cache.get(key)
    if (cached) return cached

    return this.#serial.run(async () => {
      const result = this.#filterResult(await this.downstream.listTools(params))
      this.#cache.set(key, result)
      for (const tool of result.tools) this.#advertisedTools.add(tool.name)
      return result
    })
  }

  async callTool(params, options = {}) {
    if (!this.#advertisedTools.has(params.name)) {
      throw new McpError(ErrorCode.InvalidParams, `Xcode tool is not advertised or allowed: ${params.name}`)
    }
    const { signal } = options
    return this.#serial.run(
      async () => {
        this.#activeTool = params.name
        this.#activeSince = Date.now()
        try {
          return await this.downstream.callTool(params, options)
        } catch (error) {
          if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
            await this.#recoverAfterFailure(error, `Xcode tool ${params.name}`)
          } else if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
            this.logger.error(`[broker] Xcode tool ${params.name} timed out; keeping the shared downstream connection`)
          }
          throw retryableError(error)
        } finally {
          this.#activeTool = null
          this.#activeSince = null
        }
      },
      signal,
    )
  }

  addUpstreamServer(server) {
    this.#upstreamServers.add(server)
  }

  removeUpstreamServer(server) {
    this.#upstreamServers.delete(server)
  }

  async #notifyToolListChanged() {
    await Promise.allSettled([...this.#upstreamServers].map(server => server.sendToolListChanged()))
  }

  health() {
    const status = !this.downstream.connected || this.#lastFailure
      ? "degraded"
      : (this.#ready ? "ok" : "starting")
    return {
      status,
      downstreamConnected: this.downstream.connected,
      cachedToolCount: this.#advertisedTools.size,
      upstreamSessionCount: this.#upstreamServers.size,
      queueActive: this.#serial.active,
      queuedRequestCount: this.#serial.queued,
      activeTool: this.#activeTool,
      activeDurationMs: this.#activeSince === null ? null : Date.now() - this.#activeSince,
      lastFailure: this.#lastFailure,
    }
  }

  async close() {
    if (this.#refreshRetryTimer) clearTimeout(this.#refreshRetryTimer)
    this.#refreshRetryTimer = null
    await this.downstream.close()
  }
}

function createUpstreamServer(broker, logger) {
  const server = new Server(
    { name: "xcode-mcp-broker", version: brokerVersion },
    { capabilities: { tools: { listChanged: true } } },
  )

  server.onerror = error => logger.error(`[broker] upstream error: ${errorMessage(error)}`)
  server.setRequestHandler(ListToolsRequestSchema, request => broker.listTools(request.params))
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const progressToken = extra._meta?.progressToken
    const onprogress = progressToken === undefined
      ? undefined
      : progress => {
          void extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, ...progress },
          }).catch(error => logger.error(`[broker] progress forwarding failed: ${errorMessage(error)}`))
        }

    return broker.callTool(request.params, { signal: extra.signal, onprogress })
  })
  return server
}

export async function startHttpBroker({
  broker,
  host = defaultHost,
  port = defaultPort,
  sessionIdleTimeout = Number(process.env.XCODE_MCP_SESSION_IDLE_TIMEOUT_MS ?? 5 * 60 * 1000),
  logger = console,
} = {}) {
  const app = createMcpExpressApp({ host })
  const sessions = new Map()

  const handleSessionRequest = async (session, request, response, body) => {
    session.activeRequests += 1
    session.lastSeen = Date.now()
    try {
      await session.transport.handleRequest(request, response, body)
    } finally {
      session.activeRequests -= 1
      session.lastSeen = Date.now()
    }
  }

  const sessionSweeper = setInterval(() => {
    const expiration = Date.now() - sessionIdleTimeout
    for (const session of sessions.values()) {
      if (session.activeRequests === 0 && session.lastSeen < expiration) {
        void session.server.close().catch(error => {
          logger.error(`[broker] failed to close idle session: ${errorMessage(error)}`)
        })
      }
    }
  }, Math.min(sessionIdleTimeout, 60_000))
  sessionSweeper.unref()

  app.get("/healthz", (_request, response) => {
    const health = broker.health()
    response.status(health.status === "ok" ? 200 : 503).json(health)
  })

  app.post("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"]
    try {
      if (typeof sessionId === "string" && sessions.has(sessionId)) {
        await handleSessionRequest(sessions.get(sessionId), request, response, request.body)
        return
      }

      if (sessionId || !isInitializeRequest(request.body)) {
        response.status(sessionId ? 404 : 400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Missing or invalid MCP session" },
          id: null,
        })
        return
      }

      const server = createUpstreamServer(broker, logger)
      let transport
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: initializedSessionId => {
          sessions.set(initializedSessionId, {
            server,
            transport,
            activeRequests: 0,
            lastSeen: Date.now(),
          })
          broker.addUpstreamServer(server)
        },
      })
      transport.onclose = () => {
        const initializedSessionId = transport.sessionId
        if (initializedSessionId) sessions.delete(initializedSessionId)
        broker.removeUpstreamServer(server)
      }
      await server.connect(transport)
      await transport.handleRequest(request, response, request.body)
    } catch (error) {
      logger.error(`[broker] MCP POST failed: ${errorMessage(error)}`)
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: ErrorCode.InternalError, message: "Internal broker error" },
          id: null,
        })
      }
    }
  })

  app.get("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"]
    if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
      response.status(404).send("Missing or invalid MCP session")
      return
    }
    await handleSessionRequest(sessions.get(sessionId), request, response)
  })

  app.delete("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"]
    if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
      response.status(404).send("Missing or invalid MCP session")
      return
    }
    await handleSessionRequest(sessions.get(sessionId), request, response)
  })

  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server))
    server.once("error", reject)
  })
  logger.error(`[broker] listening on http://${host}:${port}/mcp`)

  return {
    listener,
    sessions,
    async close() {
      clearInterval(sessionSweeper)
      const listenerClosed = new Promise((resolve, reject) => {
        listener.close(error => error ? reject(error) : resolve())
      })
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()))
      await listenerClosed
      await broker.close()
    },
  }
}

function parseAllowedTools(value) {
  if (!value) return undefined
  return new Set(value.split(",").map(name => name.trim()).filter(Boolean))
}

export async function main() {
  const host = process.env.XCODE_MCP_BROKER_HOST ?? defaultHost
  const port = Number(process.env.XCODE_MCP_BROKER_PORT ?? defaultPort)
  const downstream = new XcodeDownstream()
  const broker = new ToolBroker(downstream, {
    allowedTools: parseAllowedTools(process.env.XCODE_MCP_ALLOWED_TOOLS),
  })

  const httpBroker = await startHttpBroker({ broker, host, port })
  void broker.start().catch(error => {
    console.error(`[broker] Xcode is not ready; retrying in the background: ${errorMessage(error)}`)
  })
  let shuttingDown = false
  const shutdown = async signal => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[broker] received ${signal}; shutting down`)
    try {
      await httpBroker.close()
      process.exit(0)
    } catch (error) {
      console.error(`[broker] shutdown failed: ${errorMessage(error)}`)
      process.exit(1)
    }
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}
