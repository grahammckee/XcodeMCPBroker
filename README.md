# Xcode MCP Broker

A small localhost broker that lets multiple MCP clients share one persistent `xcrun mcpbridge` connection to Xcode.

<a href="https://github.com/grahammckee/XcodeMCPBroker/releases/latest/download/XcodeMCPBroker-macos-universal.pkg">
  <img src="https://img.shields.io/badge/Download-Latest_macOS_Installer-147EFB?style=for-the-badge&amp;logo=apple&amp;logoColor=white" alt="Download latest macOS installer" height="48">
</a>

With the broker, Xcode authorization normally happens once per Xcode launch. After allowing the broker connection, agents can delegate work to subagents, custom tools, and external scripts that reuse it instead of starting another bridge and requesting access again.

```text
OpenCode ------------\
Custom MCP clients ----> localhost broker --> mcpbridge --> Xcode
Automation scripts ---/
```

The broker exposes a Streamable HTTP endpoint, serializes calls to Xcode, forwards progress, cancels queued work before dispatch, caches tool discovery, and reconnects when Xcode restarts or its bridge stops responding. It binds to `127.0.0.1` by default.

## Requirements

- macOS with an Xcode version that provides `xcrun mcpbridge`
- Node.js 20 or later for source installation and development

## Xcode compatibility

The broker does not hardcode Xcode's tools. It reads `tools/list` from `mcpbridge` and refreshes the cache when the bridge reconnects or Xcode sends a `tools/list_changed` notification. New, removed, or changed tools should therefore be picked up automatically after an Xcode update without requiring a broker release. Connected MCP clients are notified when the cached tool list changes.

When Xcode is running, the broker uses the `mcpbridge` bundled with that application and pins the bridge to its process ID. This keeps beta or side-by-side Xcode installations aligned even when `xcode-select` points to another version. If no Xcode process is available, the broker waits without spawning a bridge. It monitors the pinned Xcode process and creates one replacement bridge when Xcode restarts.

This has been tested with the latest Xcode 27 beta available at the time of testing. Future Xcode versions should remain compatible as long as `mcpbridge` continues to implement the standard MCP lifecycle and tool APIs.

If `XCODE_MCP_ALLOWED_TOOLS` is set, newly added tools remain hidden until they are added to that allowlist. `XCODE_MCP_BRIDGE_COMMAND` can still override automatic bridge selection when needed.

## Installation

### macOS installer

Download the [latest universal macOS installer](https://github.com/grahammckee/XcodeMCPBroker/releases/latest/download/XcodeMCPBroker-macos-universal.pkg) and open it with Installer. The Developer ID signed and notarized package contains its own runtime, so Node.js is not required.

The package installs for the current user:

```text
~/Library/Application Support/XcodeMCPBroker/xcode-mcp-broker
~/Library/LaunchAgents/com.gmicc.opencode-xcode-mcp-broker.plist
```

The LaunchAgent starts automatically at the next login. To start it immediately after installation:

```sh
launchctl bootout gui/$(id -u)/com.gmicc.opencode-xcode-mcp-broker 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.gmicc.opencode-xcode-mcp-broker.plist"
```

### Source installation

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
      "timeout": 1860000,
      "enabled": true
    }
  }
}
```

The timeout is slightly longer than the broker's default 30-minute maximum so long-running Xcode operations can return their result or broker timeout. Restart OpenCode after changing its configuration.

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

To remove a package installation while retaining its logs:

```sh
"$HOME/Library/Application Support/XcodeMCPBroker/xcode-mcp-broker" uninstall
```

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `XCODE_MCP_BROKER_HOST` | `127.0.0.1` | HTTP bind address |
| `XCODE_MCP_BROKER_PORT` | `7341` | HTTP port |
| `XCODE_MCP_BRIDGE_COMMAND` | automatic | Override the bridge executable; otherwise wait for and use a running Xcode's bridge |
| `XCODE_MCP_ALLOWED_TOOLS` | all tools | Comma-separated tool allowlist |
| `XCODE_MCP_DISCOVERY_TIMEOUT_MS` | `10000` | Timeout for later Xcode tool-list refreshes; initial discovery waits up to the maximum request duration for authorization |
| `XCODE_MCP_REQUEST_TIMEOUT_MS` | `45000` | Downstream no-progress timeout; progress notifications reset it |
| `XCODE_MCP_MAX_TOTAL_TIMEOUT_MS` | `1800000` | Maximum total duration of a downstream request |
| `XCODE_MCP_SESSION_IDLE_TIMEOUT_MS` | `300000` | Idle upstream session timeout |
| `XCODE_MCP_XCODE_STARTUP_GRACE_MS` | `5000` | Delay before connecting to a newly launched Xcode process |

These variables are read directly when running in the foreground. To persist an override in the LaunchAgent, provide it while installing:

```sh
XCODE_MCP_ALLOWED_TOOLS="XcodeListWindows,BuildProject" npm run service:install
```

The broker does not provide authentication. Keep it bound to the loopback interface unless you add an appropriate access-control layer.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, and release-label requirements. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Do not open public issues for suspected vulnerabilities. Follow the private reporting process in [SECURITY.md](SECURITY.md).

### Repository layout

| Path | Purpose |
|---|---|
| `src/` | Broker runtime and standalone executable entrypoint |
| `test/` | Node test suites |
| `scripts/` | Development, installation, and release commands |
| `scripts/lib/` | Shared release-policy helpers |
| `packaging/` | macOS signing and installer metadata |
| `.github/` | CI, release automation, Dependabot, and contribution templates |

## License

Licensed under the [MIT License](LICENSE).
