# Xcode MCP Broker

A small localhost broker that lets multiple MCP clients share one persistent `xcrun mcpbridge` connection to Xcode.

With the broker, Xcode authorization normally happens once per Xcode launch. After allowing the broker connection, agents can delegate work to subagents, custom tools, and external scripts that reuse it instead of starting another bridge and requesting access again.

```text
OpenCode ------------\
Custom MCP clients ----> localhost broker --> mcpbridge --> Xcode
Automation scripts ---/
```

The broker exposes a Streamable HTTP endpoint, serializes calls to Xcode, forwards progress and cancellation, caches tool discovery, and reconnects when Xcode restarts. It binds to `127.0.0.1` by default.

## Requirements

- macOS with an Xcode version that provides `xcrun mcpbridge`
- Node.js 18 or later

## Xcode compatibility

The broker does not hardcode Xcode's tools. It reads `tools/list` from `mcpbridge` and refreshes the cache when the bridge reconnects or Xcode sends a `tools/list_changed` notification. New, removed, or changed tools should therefore be picked up automatically after an Xcode update without requiring a broker release. Connected MCP clients are notified when the cached tool list changes.

When Xcode is running, the broker uses the `mcpbridge` bundled with that application and pins the bridge to its process ID. This keeps beta or side-by-side Xcode installations aligned even when `xcode-select` points to another version. If no Xcode process is available, the broker falls back to `xcrun mcpbridge` while it waits and retries.

This has been tested with the latest Xcode 27 beta available at the time of testing. Future Xcode versions should remain compatible as long as `mcpbridge` continues to implement the standard MCP lifecycle and tool APIs.

If `XCODE_MCP_ALLOWED_TOOLS` is set, newly added tools remain hidden until they are added to that allowlist. `XCODE_MCP_BRIDGE_COMMAND` can still override automatic bridge selection when needed.

## Installation

Clone the repository, install dependencies, and run the tests:

```sh
git clone https://github.com/grahammckee/XcodeMCPBroker.git
cd XcodeMCPBroker
npm install
npm test
```

Install the broker as a user LaunchAgent:

```sh
npm run service:install
```

The installer uses the current Node executable and repository path, starts the broker at login, and writes logs to `~/Library/Logs/xcode-mcp-broker.log`.

Xcode does not need to be open when the service starts. The broker remains available and retries until Xcode launches. Xcode may show its normal **Allow** dialog when the connection is first established.

### OpenCode

Point OpenCode at the broker in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "xcode": {
      "type": "remote",
      "url": "http://127.0.0.1:7341/mcp",
      "oauth": false,
      "enabled": true
    }
  }
}
```

Restart OpenCode after changing its configuration.

## Verification

```sh
curl --fail http://127.0.0.1:7341/healthz
npm run broker:smoke
launchctl print gui/$(id -u)/com.gmicc.opencode-xcode-mcp-broker
```

The smoke command waits up to 60 seconds for initial Xcode discovery, then lists the available tools and calls the read-only `XcodeListWindows` tool.

To run the broker in the foreground instead:

```sh
npm run broker:start
```

To remove the LaunchAgent:

```sh
npm run service:uninstall
```

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `XCODE_MCP_BROKER_HOST` | `127.0.0.1` | HTTP bind address |
| `XCODE_MCP_BROKER_PORT` | `7341` | HTTP port |
| `XCODE_MCP_BRIDGE_COMMAND` | `/usr/bin/xcrun` | Bridge executable |
| `XCODE_MCP_ALLOWED_TOOLS` | all tools | Comma-separated tool allowlist |
| `XCODE_MCP_REQUEST_TIMEOUT_MS` | `600000` | Downstream request timeout |
| `XCODE_MCP_SESSION_IDLE_TIMEOUT_MS` | `300000` | Idle upstream session timeout |

These variables are read directly when running in the foreground. To persist an override in the LaunchAgent, provide it while installing:

```sh
XCODE_MCP_ALLOWED_TOOLS="XcodeListWindows,BuildProject" npm run service:install
```

The broker does not provide authentication. Keep it bound to the loopback interface unless you add an appropriate access-control layer.

## Contributing

Issues and pull requests are welcome. For code changes:

1. Create a focused branch from the current default branch.
2. Add or update tests for protocol, lifecycle, or concurrency behavior.
3. Run `npm test`.
4. If the change affects the live transport, run `npm run broker:smoke` with Xcode open.
5. Explain the behavior change and verification performed in the pull request.

Downstream calls are intentionally serialized. Changes to concurrency, cancellation, or retry behavior should account for Xcode operations whose outcome may be uncertain after a connection failure.

## License

Licensed under the [MIT License](LICENSE).
