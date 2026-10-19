# Jev × FilmCraft

A separate API/MCP plugin over the real [FilmCraft](https://github.com/storytold/filmcraft) editing engine. Jev can inspect a project, import media, edit a timeline, render a preview and export video using MCP alone.

## Download the app

Download a ZIP for your computer from [Releases](https://github.com/yuyanghu06/jev-filmcraft/releases):

- **Mac (Apple Silicon or Intel, macOS 13.5+):** unzip, drag **Jev FilmCraft.app** into Applications, and open it.
- **Windows (x64, Windows 10/11):** extract the entire **Jev FilmCraft** folder somewhere permanent, then double-click **JevFilmCraft.exe**. Keep its companion folders beside it.

Node, Rust and a FilmCraft checkout are not needed. Choose a provider in the sidebar, open Settings, paste your own API key, and click Apply. **Save on this device** remembers it in a private, unencrypted local file outside the app.

These preview downloads are not notarized on Mac or signed on Windows, so first launch can show an OS security prompt. See [desktop installation and packaging details](plugins/filmcraft/packaging/README.md). The source setup below remains available for development and MCP-only use.

```text
Jev / any MCP client
    │ stdio or authenticated Streamable HTTP
plugins/filmcraft/src/mcp
    │ HTTP requests
plugins/filmcraft/src/api
    │ persistent native MCP connection
plugins/filmcraft/src/adapters
    │
vendor/filmcraft ── headless engine OR live desktop bridge
```

FilmCraft is a Git submodule pinned to `105c09bd80e2c86ec7464a2c59a2501eb89ffc5c` (0.9.0). It already provides a native command channel and basic MCP server. This plugin adds an authenticated HTTP API, 50 named tools for headless use (54 in desktop mode), shared schemas/OpenAPI, lifecycle management, and an optional embedded chat panel. A reproducible 11-line upstream hook loads the sidebar from the plugin folder. All **701 native engine commands** at the pinned revision are accessible through command discovery/execution, including features without a dedicated named tool. Command availability still depends on native build features and current project state.

## Run

Requires Node.js 22+ and Rust 1.95+ (or an existing FilmCraft CLI).

```sh
git submodule update --init --recursive
npm ci
npm run build:filmcraft
npm run build
npm run check
npm run test:integration
npm run demo
```

The demo uses a real MCP stdio client and produces `artifacts/demo/edit.mp4`, a saved `.fcproj`, a PNG preview, SRT captions, an OTIO timeline and `report.json`. It also imports the resulting MP4 and decodes a frame to verify the export. All input media is generated locally. No model is used in this deterministic transport/engine evaluation; Jev's ability to choose the right edits remains a separate evaluation.

## Install into an existing FilmCraft checkout

The sidebar is a source plugin: it applies a small UI hook and rebuilds FilmCraft. The plugin repository contains the integration code and an optional upstream submodule reference, not a copy of FilmCraft's source or binaries.

With Node.js 22+ and Rust 1.95+ installed, point the plugin at your FilmCraft checkout:

```sh
export FILMCRAFT_DIR="/absolute/path/to/filmcraft"
git clone https://github.com/yuyanghu06/jev-filmcraft.git
cd jev-filmcraft
npm ci
npm run build
npm run build:filmcraft
npm run build:desktop
npm run chat:config
# Fill in apiKey values in plugins/filmcraft/config/providers.local.json.
npm run chat
```

You do not need to initialize this plugin repo's submodule when using `FILMCRAFT_DIR`. Keep that variable set when building or launching in a new terminal. The hook resolves the sidebar source relative to your FilmCraft checkout, so keep both directories in place. `npm run patch:filmcraft -- /absolute/path/to/filmcraft` applies only the hook; `build:desktop` applies it automatically. Reapplying is safe and conflicting changes are rejected without resetting your files.

The tested upstream revision is `105c09bd80e2c86ec7464a2c59a2501eb89ffc5c` (0.9.0). For a fresh reproducible FilmCraft checkout, clone `https://github.com/storytold/filmcraft.git` and check out that revision before the commands above. Other revisions may need an updated hook. Launch via `npm run chat` to start the local API/MCP service and sidebar together. For MCP-only use, skip `build:desktop` and `chat:config`, then use the configuration below.

## Give Jev the MCP server

Use a direct Node command (not `npm run mcp`, whose npm banner would pollute MCP stdout). Replace the path with this checkout's absolute path:

```json
{
  "mcpServers": {
    "filmcraft": {
      "command": "node",
      "args": ["/absolute/path/jev-filmcraft/plugins/filmcraft/dist/cli.js", "mcp"]
    }
  }
}
```

Run `npm run --silent mcp:config` to generate this JSON with the correct absolute Node and entry-point paths for your machine. A local copy for this checkout is in `artifacts/mcp.json` after setup.

This starts a private HTTP API on an ephemeral loopback port, generates an in-memory token, and starts one persistent headless FilmCraft session. No other server needs to be started. Saving is explicit; closing the server ends the session. Add `FILMCRAFT_PROJECT=/absolute/path/edit.fcproj` to reopen work at startup. Use `FILMCRAFT_BIN` for an installed CLI or when moving the plugin out of this repository.

For an HTTP MCP client, start the API:

```sh
export FILMCRAFT_API_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run api
```

Connect Jev to `http://127.0.0.1:8765/mcp` using `Authorization: Bearer <the token>`. This is stateless Streamable HTTP transport over a **shared, stateful editing session**. The token is required on every request. An SSH tunnel or authenticated TLS reverse proxy is needed if Jev runs elsewhere; the service intentionally binds only to loopback.

## Edit in the FilmCraft window

To launch the embedded assistant sidebar:

```sh
npm run build:filmcraft
npm run build:desktop  # applies the small upstream hook automatically
npm run build
npm run chat
```

Put provider API keys in a local configuration file:

```sh
npm run chat:config
# Edit plugins/filmcraft/config/providers.local.json and fill in each apiKey.
npm run chat
```

The file has separate `claude`, `chatgpt`, and `jev` sections, each with `apiKey` and `model`. It is ignored by Git and created with owner-only permissions. Leave keys blank for providers you do not use. A safe [example](plugins/filmcraft/config/providers.example.json) is tracked for new checkouts. `npm run chat:config` preserves an existing file. Restart the chat launcher after editing it. To use another location, set `FILMCRAFT_PROVIDERS_CONFIG=/absolute/path/providers.json`.

Select **Claude**, **ChatGPT**, or **Jev · Experimental** in the sidebar. Settings override its key and model for the current session; check **Save on this device** to persist the supplied fields to the local configuration file. This is checked by default in the packaged app and unchecked in source launches. Alternatively set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `TYPESAFE_API_KEY` (`JEV_API_KEY` is an alias) before launching. Model overrides: `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `JEV_MODEL`. Environment variables override file settings, even when a key is explicitly empty. These are direct provider APIs; a consumer chat subscription is not an API credential.

**Codex** and **Claude Code** are also in the picker. They display a copyable MCP install command, which attaches the coding agent to this same live project. Installation is never executed automatically. Keep `npm run chat` running, paste the command into PowerShell on Windows or a terminal on Mac, and restart the agent. The installed stdio connector reads a private, ignored session file rather than putting the local bearer token into the install command. It reconnects to the next desktop session when restarted.

Jev uses the [TypeSafe System One API](https://docs.typesafe.ai/api), with **`TypeSafe-Danger-Zone-Images: true`** on every request and a desktop screenshot as visual context. It selects tools and grounded argument candidates using Choice questions. It does not generate chat prose or arbitrary JSON: quote title/caption text, supply numeric values, and put complex arguments in a JSON code block. The harness stops for missing or low-confidence decisions. No other model is used as a fallback. See the [Jev image protocol](https://docs.typesafe.ai/images) and [function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling).

The sidebar calls the same MCP → HTTP → FilmCraft pipeline as external agents. Tool activity is visible, Stop prevents subsequent calls (completed edits remain), and FilmCraft Undo reverts edits. Provider switching starts a fresh conversation. The chosen provider receives your messages, project context, tool results and requested preview images. Chat history stays in memory. Keys saved with **Save on this device**, or entered in the local configuration file, are loaded on startup. The **API key configured** label indicates presence, not successful authentication.

`FILMCRAFT_PROJECT=/absolute/path/edit.fcproj npm run chat` opens an existing project. The normal launcher accepts keyboard and mouse input; automation-only input is enabled exclusively by the UI test harness.

`npm run test:chat-ui` exercises the actual sidebar, settings, provider menu, composer, Jev image decisions, a real MCP marker edit, installation command copy, and collapse/restore. It uses **fixture provider responses**, saves screenshots and a report under `artifacts/chat`, and does not test live cloud inference. Generate demo media with `npm run demo` first.

For a desktop without the sidebar:

```sh
npm run build:desktop
vendor/filmcraft/target/debug/filmcraft --control 9876 --empty
```

Set `FILMCRAFT_MODE=bridge` and `FILMCRAFT_BRIDGE=127.0.0.1:9876` in Jev's MCP server environment. The same editing tools now operate on the live desktop session; four additional tools expose UI inspection, elements, screenshots and the full control protocol. Headless edits do not automatically appear in an independently running desktop window: use bridge mode to share it, or open the saved project.

After `npm run demo` and `npm run build:desktop`, `npm run test:bridge` launches an isolated desktop instance, verifies live editing and UI/screenshot tools, saves `artifacts/bridge/desktop.png`, and closes the test instance. Run it in a graphical desktop session; it is separate from headless CI.

The native desktop control port is unauthenticated and should remain local. The plugin's HTTP endpoint is authenticated. Both expose local file operations to trusted clients; this is not a multi-tenant or filesystem-sandboxed service.

See [plugin documentation](plugins/filmcraft/README.md) for API routes, feature coverage, configuration, time units, error semantics and extending the plugin. Upstream source and licenses stay under `vendor/filmcraft`; the optional sidebar hook is maintained in `plugins/filmcraft/native/filmcraft.patch`.
