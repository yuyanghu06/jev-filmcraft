# FilmCraft API and MCP plugin

All integration code lives here. `src/adapters/native.ts` owns the persistent upstream CLI process; `src/api/` owns the HTTP service/client and OpenAPI; `src/tools/` owns named tool schemas; `src/mcp/` exposes the HTTP API as MCP. Neither Jev nor the API reimplements editing/rendering. The plugin can be moved alongside another FilmCraft installation by setting `FILMCRAFT_BIN`.

`src/chat/` contains provider adapters, the bounded agent loop and the desktop launcher. `native/panel.rs` is the egui sidebar; `native/filmcraft.patch` adds an optional native field, render hook, and read-only `chat.inspect` control method to upstream. Run `npm run patch:filmcraft` to apply it; applying twice is safe and incompatible local changes cause a clean failure. Set `FILMCRAFT_DIR` to use another FilmCraft checkout for patching, building and launching; the installer calculates the relative sidebar module path automatically. Keep both checkouts in place after installation. See the [fresh checkout instructions](../../README.md#install-into-an-existing-filmcraft-checkout). Headless API/MCP use does not require the patch.

The chat picker includes Claude, ChatGPT, Jev (experimental), Codex and Claude Code. The first three run direct provider requests; the last two show terminal installation commands for MCP clients. All sidebar edits traverse a Streamable HTTP MCP client → the same API → native FilmCraft. Provider code has no direct engine access. Native UI controls have `chat.*` automation IDs.

The sidebar uses FilmCraft's live `Tokens`, fonts, toolbar icons and disclosure rows. Its tab strip, fields, borders and focus outline follow the editor's dark, medium and light themes and custom accent settings. The UI smoke test captures all three themes plus provider settings and MCP installation views.

Provider adapters follow [Claude Messages tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [OpenAI Responses function calling](https://developers.openai.com/api/docs/guides/function-calling), and [TypeSafe Choice function calling](https://docs.typesafe.ai/cookbooks/function_calling). Jev sends `TypeSafe-Danger-Zone-Images: true`, attaches a PNG screenshot when its dimensions satisfy the protocol, and selects tool arguments from enums, defaults, inspected project fields and user-supplied literals. Complex objects must be explicitly supplied in a JSON code block. Jev decisions are validated and require confidence ≥0.6. Requests never silently fall back to a different provider.

Only one chat run may edit at a time. Other MCP clients and manual editing can still change the same project. Runs are capped at 40 tool calls, 16 Claude/ChatGPT rounds or 12 Jev actions. Provider requests time out after 120 seconds, are cancellable, and are never automatically retried. Stop cannot roll back completed edits or cancel an already-dispatched engine command/export. Use native Undo and job cancellation tools as appropriate. Switching providers starts a new conversation; histories remain in memory until the launcher exits. Settings also remain in memory unless **Save on this Mac** is checked. At most 20 sessions and 40 recent runs are retained. The UI sends no provider credential to a model or an MCP tool.

Provider keys and models can also be configured in `config/providers.local.json`. Run `npm run chat:config` from the repository root to create it from [providers.example.json](config/providers.example.json), then fill in the `apiKey` fields. The command never overwrites existing settings and creates new files with mode 0600. Local config files are Git-ignored. Restart `npm run chat` to reload edits. `FILMCRAFT_PROVIDERS_CONFIG` selects an alternative path; a missing explicitly selected file is an error, while a missing default file is optional. The loader validates fields and omits file contents from error messages.

Precedence is session Settings → environment variables → local file → built-in defaults. `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, `OPENAI_API_KEY`/`OPENAI_MODEL`, and `TYPESAFE_API_KEY`/`JEV_MODEL` override the corresponding file entries. `JEV_API_KEY` is accepted when `TYPESAFE_API_KEY` is unset. An explicitly empty environment key disables a file key. With **Save on this Mac** checked, Apply/Clear writes only the supplied fields to the local JSON file atomically with mode 0600, preserving other providers. The file is not encrypted. Without it, changes affect only the session. Environment overrides still apply after restart. File credentials are passed only to the chat service, not added to the FilmCraft child process environment. Jev's experimental image header stays enabled. Codex and Claude Code continue using their own credentials through their MCP installations.

Desktop mode additionally enables these authenticated routes (disabled in ordinary standalone API mode):

| Endpoint | Purpose |
|---|---|
| `GET /v1/chat/providers` | Models, credential-presence flags and copyable install commands; no keys |
| `POST /v1/chat/config` | Set provider, optional model and API key; empty key removes it; `persist: true` also saves supplied fields locally |
| `POST /v1/chat/runs` | Start a turn: provider, message, optional session UUID |
| `GET /v1/chat/runs/{id}` | Poll status and user/assistant/tool events |
| `POST /v1/chat/runs/{id}/cancel` | Abort the provider call and prevent subsequent tool calls |

Run `npm run chat` from the repository root. `desktop-mcp` is the installed external agent command; it reads the active launcher's ignored `artifacts/chat/session.json` (local token, mode 0600) and fails clearly if no desktop is running. The plugin never installs itself into Codex or Claude Code without the user running the displayed command.

The [standalone macOS app](packaging/README.md) includes the runtime and binaries. Its launcher sets `FILMCRAFT_STATE_DIR` to `~/Library/Application Support/Jev FilmCraft` and uses `providers.json`, `session.json`, and the `editor` data directory there. External MCP install commands use the bundled bootstrap so they find the same session after app updates. No settings are written inside the signed app.

## API

Every request requires `Authorization: Bearer <FILMCRAFT_API_TOKEN>`. POST bodies must be JSON. The service binds `127.0.0.1`, checks the Host header, rejects browser Origin headers and limits request bodies to 4 MiB. The token must contain at least 24 characters. Use a randomly generated token.

| Endpoint | Purpose |
|---|---|
| `GET /v1/health` | Backend connection and headless/bridge mode |
| `GET /v1/tools` | Named tool schemas and annotations |
| `POST /v1/tools/{name}` | Call a named tool; body is its arguments |
| `GET /v1/commands?filter=timeline.&offset=0&limit=50` | Live native command discovery, parameter docs and current enablement |
| `POST /v1/commands/{id}` | Run any native command; body is its params object |
| `POST /v1/batch` | Ordered commands, optionally continue on error |
| `GET /v1/document` | Project tree and active sequence |
| `POST /v1/render` | PNG preview, returned as MCP image content |
| `GET /v1/openapi.json` | Generated OpenAPI 3.1 specification |
| `POST /mcp` | Stateless MCP Streamable HTTP; same editing session |

Operation responses preserve MCP content:

```json
{"result":{"content":[{"type":"text","text":"{\"sequence\":4}"}],"isError":false}}
```

`isError` may be absent on success. Preview/screenshot results contain `{type:"image",mimeType:"image/png",data:"<base64>"}` so Jev receives pixels, not just an output path. The exported TypeScript `FilmcraftApiClient` handles responses; `resultData(result)` parses text JSON for HTTP consumers. MCP clients should consume `content` directly.

```sh
curl --fail-with-body http://127.0.0.1:8765/v1/tools/filmcraft_sequence_create \
  -H "Authorization: Bearer $FILMCRAFT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Main","width":1920,"height":1080,"fps":24}'
```

HTTP 400 means invalid arguments, 401 authentication, 403 forbidden Host/Origin, 404 unknown tool/route, 409 desktop-only tool in headless mode, 413 oversized body, 415 wrong content type, 422 an engine/tool error (including partial batch failure), 429 a full request queue, and 502/503 a backend/transport failure. Transport/config errors have `{error:{code,message}}`; 422 retains `{result:{isError:true,content:[...]}}`.

## Feature coverage

The named tools are a convenient subset. `filmcraft_commands` + `filmcraft_execute` expose the **entire live registry**; this avoids copying 701 imperfect schema strings into a static tool list. Native parameter docs are returned verbatim. Registry `enabled` describes the current selection; an explicitly named valid clip/item can still be actionable when `enabled` is false.

| Functionality | Named entry points / native command families |
|---|---|
| Project create/open/save and bins | `project_new`, `project_open`, `project_save`, `bin_create`, `inspect`; `file.*`, `project.*` |
| Import, media availability, relink, proxies, ingest | `media_import`, `media_status`; `media.*`, `proxies.*`, `project.ingestSettings` |
| Sequences and tracks | `sequence_create`, `sequence_open`, `sequence_inspect`, `tracks_add`; `sequence.*` |
| Place/move/copy/split/trim/roll/slip/slide/speed | `clip_*`; `timeline.*`, `clip.*`, `trim.*` |
| Selection, delete/ripple delete, undo/redo | `clip_select`, `selection_delete`, `selection_ripple_delete`, `undo`, `redo`; `edit.*` |
| Effects, transforms, opacity, keyframes, masks | `effects_list`, `effect_apply`, `effect_set`, `effect_remove`; `effects.*` |
| Color correction, grading, LUTs, HDR | `effect_apply` / `effect_set` with `lumetri`; `lumetri.*`, `lut.*`, `sequence.colorSettings` |
| Video/audio transitions | `transition_video`, `transition_audio`; `sequence.setTransition`, `effects.setDefaultTransition` |
| Audio gain, DSP, mixing, routing and automation | `audio_gain`, `mixer_inspect`, `mixer_set`, effect tools; `mixer.*`, `essentialSound.*` |
| Titles, shapes, graphic layers | `title_create`, `graphic_set`; `graphics.*` |
| Captions, subtitle import/export | `captions_list`, `caption_add`, `caption_set_text`, `captions_import`, `captions_export`; `captions.*` |
| Markers, in/out, playhead | `marker_add`, `playhead_set`; `markers.*` |
| Nesting and multicam | `sequence.*`, `clip.*`, `multicam.*` through command execution |
| Transcription and text editing | `transcript.*` (speech generation requires a native Whisper-enabled build and installed model) |
| Preview and export | `render_preview`, `export_start`, `jobs_list`, `jobs_cancel`; `export.*`, `file.exportMedia` |
| Editing interchange | `interchange_export`; import XML/FCPXML/OTIO/AAF with `media_import` / `file.import`, native export options via command discovery |
| Desktop playback, tools, panels and UI | `ui_inspect`, `ui_elements`, `ui_screenshot`, `ui_control` in bridge mode |

All tool names have the `filmcraft_` prefix. `GET /v1/tools` is the authoritative schema list; OpenAPI is generated from the same definitions used to validate arguments. `effects_list` accepts `kind`, `folder`, and `detail:true` to return effect parameter definitions.

## Session, time and failure semantics

- One API process owns one session. Clients attached to that API share selection, project, history and jobs. Two independently launched managed stdio servers have independent headless sessions.
- Commands are serialized; a batch cannot interleave with other edits through this service. Job polling/cancellation bypasses the queue so an explicitly waiting export remains cancellable. Native desktop interaction or other direct control clients are outside this queue.
- Batches are **not transactions**. Successful steps remain applied; each native edit creates its usual undo entry. `stop_on_error` defaults to true; a partial failure returns results and `isError:true`.
- Project save is explicit. New/open replaces the current session document; save first. A disconnected backend is reported, not silently restarted. Neither failed requests nor uncertain timeouts are automatically retried: an operation may already have happened.
- `file.import` can partially succeed: inspect its `errors` array even when the tool result succeeds. Imported item IDs are in `items`.
- Prefer `export_start` (always `wait:false`), then `jobs_list`. Completion means **`finished:true`**, not `done` (which is a count of processed frames). A successful terminal job has a report in `result`; a failed/cancelled job has `result.error`. Also inspect `offlineMedia` for placeholder footage. Cancellation can leave a partial file; success is never inferred from file existence alone.
- Times use 254,016,000,000 integer ticks per second. Prefer `frame`, `seconds` or `timecode` where a command supports them. `clip_move.time`, `clip_place.sourceIn/duration`, and `effect_set.time` are ticks. `clip_trim.deltaFrames` is signed sequence frames. **`title_create.seconds` is duration**, `time` is start in ticks, and its `track` is a zero-based video-track index (other timeline tools use `V1`/`A1` or track IDs).
- Unsafe integer arguments are rejected rather than rounded. Upstream MCP text JSON is preserved verbatim. `resultData()` returns integers outside JavaScript's safe range as decimal strings. Such strings are for inspection, not native tick inputs; use seconds/frame/timecode on long timelines. Native engine tick math remains Rust integer arithmetic.
- File paths are absolute and refer to the FilmCraft host, including bridge mode. This service is for trusted local agents and does not confine filesystem access. Generic command params retain native semantics and validation.
- Headless mode has no desktop playback/window. Desktop preview screenshots require a visible rendering window. Supported codecs, optional AI features and hardware encoding depend on the pinned native build and platform. This adapter cannot make upstream unimplemented features work.

## Configuration

Set environment variables in the shell or MCP client's `env`; `.env` files are not loaded automatically.

| Variable | Default / meaning |
|---|---|
| `FILMCRAFT_DIR` | FilmCraft source checkout for builds and binary discovery; defaults to this repo's `vendor/filmcraft` |
| `FILMCRAFT_BIN` | Auto-detect `FILMCRAFT_DIR/target/{release,debug}/filmcraft-cli`; override for an installed CLI or a custom Cargo target directory |
| `FILMCRAFT_DESKTOP_BIN` | Auto-detect `FILMCRAFT_DIR/target/{debug,release}/filmcraft`; override for an installed desktop or a custom Cargo target directory |
| `FILMCRAFT_STATE_DIR` | Optional directory for `session.json`; source launches default to `artifacts/chat`, packaged launches use Application Support |
| `FILMCRAFT_MODE` | `headless` or `bridge` (default headless) |
| `FILMCRAFT_BRIDGE` | `127.0.0.1:9876`, desktop native control channel |
| `FILMCRAFT_PROJECT` | Project to open at startup, headless only |
| `FILMCRAFT_DEMO` | `true` to open upstream's demo, headless only; mutually exclusive with project |
| `FILMCRAFT_DATA_DIR` | Headless defaults to `~/.local/share/jev-filmcraft`; separate presets from the normal desktop |
| `FILMCRAFT_TIMEOUT_MS` | Native request timeout, default 120000 (range 1000–3600000) |
| `FILMCRAFT_API_PORT` | API command defaults to 8765; 0 chooses a free port |
| `FILMCRAFT_API_TOKEN` | Required for standalone API/external API connection; generated internally for managed stdio |
| `FILMCRAFT_API_URL` | MCP connects to an existing API instead of starting an engine; requires its token |

Example configs: [managed headless](examples/mcp.json), [desktop bridge](examples/mcp-bridge.json), [shared API](examples/mcp-api.json). Replace placeholder absolute paths. Generic `mcpServers` JSON is portable among clients with that configuration format; clients with a different config schema should use the same command/args/env or HTTP URL/header settings.

The MCP server offers `filmcraft://document` and `filmcraft://capabilities` resources. HTTP MCP is stateless at the protocol layer (POST only, no SSE event stream or session IDs), while the underlying editing session persists. Stdio emits protocol messages only; diagnostics go to stderr. Closing the managed MCP process closes its private API and native child; connecting to an external API leaves it running.

## Extend and evaluate

1. Discover the exact native command and its parameters (`filmcraft_commands`).
2. Add a schema and mapping in `src/tools/catalog.ts`. HTTP and MCP use that same definition automatically. Keep transport-specific code in `adapters/`.
3. Add a real engine scenario for behavior that matters. Never implement another timeline model in the plugin.
4. Run `npm run check`, `npm run test:integration`, then `npm run demo` from the repository root.

The deterministic evaluation exercises real media import, split/trim and undo/redo, Lumetri, animated scale, audio gain/mixer, transition, title, captions, marker, PNG rendering without changing the playhead, `.fcproj` save/reopen, SRT/OTIO output, asynchronous H.264+AAC export and decoding the export. Additional tests cover partial batches, multiple clients, cancellation, auth, schema errors, large ticks, PNG transport and Streamable HTTP.

To evaluate Jev, give it the MCP server plus paths to test footage and ask it to make a short edit, save a project and export an MP4. Check its `render_preview` observations, final job report and exported file. The included demo proves the tools execute a complete workflow; it does not measure model planning or artistic judgment.
