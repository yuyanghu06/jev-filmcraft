# FilmCraft API and MCP plugin

All integration code lives here. `src/adapters/native.ts` owns the persistent upstream CLI process; `src/api/` owns the HTTP service/client and OpenAPI; `src/tools/` owns named tool schemas; `src/mcp/` exposes the HTTP API as MCP. Neither Jev nor the API reimplements editing/rendering. The plugin can be moved alongside another FilmCraft installation by setting `FILMCRAFT_BIN`.

`src/chat/` contains provider adapters, the bounded agent loop and the desktop launcher. `native/panel.rs` is the egui sidebar; `native/filmcraft.patch` adds an optional native field, render hook, and read-only `chat.inspect` control method to upstream. `native/audio.rs` and its independent `audio.patch` add the read-only `audio.read` engine query. Run `npm run patch:filmcraft` to apply both; applying twice is safe and incompatible local changes cause a clean failure. Both native builds apply the audio hook; only the desktop build needs the sidebar hook. Set `FILMCRAFT_DIR` to use another FilmCraft checkout for patching, building and launching; the installer calculates relative module paths automatically. Keep both checkouts in place after installation. See the [fresh checkout instructions](../../README.md#install-into-an-existing-filmcraft-checkout).

The chat picker includes Claude, ChatGPT, Jev (experimental), Codex and Claude Code. The first three run direct provider requests; the last two show terminal installation commands for MCP clients. All sidebar edits traverse a Streamable HTTP MCP client → the same API → native FilmCraft. Provider code has no direct engine access. Native UI controls have `chat.*` automation IDs.

The sidebar uses FilmCraft's live `Tokens`, fonts, toolbar icons and disclosure rows. Its tab strip, fields, borders and focus outline follow the editor's dark, medium and light themes and custom accent settings. The UI smoke test captures all three themes plus provider settings and MCP installation views.

## LLM planning and Jev execution

Claude/ChatGPT default to `execution: "direct"`. Choose **Execute edits → Jev** to use the selected LLM for perception and creative cut decisions and Jev for the resulting actions. The planner can inspect state/images, listen to audio, and submit `filmcraft_execute_plan`; direct mutating tools are withheld in this mode. Jev receives the plan and fresh timeline snapshots with exact native arguments and no media attachments. Standalone `provider: "jev"` remains an experimental direct mode. Every run reports its effective `execution` mode.

All LLM MCP clients, including Codex and Claude Code, can submit the same `filmcraft_execute_plan` tool through desktop or headless API/MCP services. Configure Jev credentials separately in the sidebar or `TYPESAFE_API_KEY` / `JEV_API_KEY`. Inspect `filmcraft_inspect` or `filmcraft_sequence_inspect` first, then supply the actual active sequence ID and clip snapshot. For example, after inspection returns sequence 7 and a clip 11 on V1 starting at frame 0 with 120 frames:

```json
{"plan":{"version":1,"objective":"Split the opening at the LLM-selected boundary","sequence":7,"steps":[{"id":"opening-cut","operation":"split","target":{"clip":11,"track":"V1","startFrame":0,"durationFrames":120},"atFrame":48,"outcome":"Two clips separated at frame 48"}]}}
```

Version 1 supports ordered `split` (`atFrame`), regular `trim` (`edge`, signed `deltaFrames`), `remove-range` (`startFrame`, `endFrame`, optional `ripple`) and `move` (`toTrack`, `toFrame`, optional `linked`). Targets identify inspected clips or an earlier result as `{"stepId":"opening-cut","segment":"left"}` (`right`/`only` are also available). Each step needs a unique ID and intended `outcome`; at most 24 steps are accepted. Frame positions are absolute sequence frames. Tool schemas from `GET /v1/tools` are authoritative. Verification runs after actions; stale targets, cancellation, rejected choices or failed verification stop further edits and return partial results plus refreshed clip IDs. Completed edits remain; inspect and create a new plan instead of replaying an ambiguous failure.

## Listening to imported and timeline audio

`filmcraft_audio_read({"startSeconds":0,"durationSeconds":10,"track":"A1","sampleRate":16000})` returns actual timeline-rendered mono PCM16 WAV as MCP audio content plus provenance text. Supported output rates are 16000 (default) and 24000 Hz; duration must be greater than zero and at most 30 seconds. The end clamps to the sequence duration and returned boundaries align to the output sample grid. The read preserves clip timing, source offsets, speed, clip effects and transitions. With no `track`, it renders the full sequence mixer, including mute/solo and routing. An explicit audio ID or `A1` reads the track input before its mixer, so it bypasses that track's mute/solo/fader/inserts/routing. It does not change project data, selection, history or playhead. Offline media is reported; do not infer silence from missing media.

To listen before placement, use media item IDs from `filmcraft_inspect`'s bin or `filmcraft_media_import`: `filmcraft_audio_read({"item":123,"startSeconds":2,"durationSeconds":10,"audioStream":0})`. The same selectors work with `filmcraft_audio_analyze`. Imported audio and audio within imported video are supported without an active sequence, source monitor, or timeline clip. `audioStream` is a zero-based stream index, defaulting to 0; it requires `item`. `item` and timeline `track` are mutually exclusive. A sequence, subclip, or media item without audio is rejected. Reads always use the original media, even when proxy playback is enabled. Missing/offline originals are reported and analysis refuses them.

In item mode, times are **source-media seconds** and the end clamps to media duration. Provenance contains `source` (item, name, kind, path, duration), selected `audioStream`, `availableAudioStreams`, `timeBasis:"source"`, `signalPath:"source_original"`, `requestedRange`, `actualRange`, `mediaStatus` and `offlineMedia`. Timeline reads use `timeBasis:"timeline"`. Helper observations retain these fields and distinguish excerpt-relative timestamps from absolute source offsets. The planner must use actual placement/source-in/speed to map source observations onto timeline cuts. No placement is implied by reading an imported item.

`filmcraft_audio_analyze` accepts the same fields plus an optional `question`, sends the WAV to an OpenAI audio model and returns observations attributed to that model, with source/stream or timeline/track provenance. The built-in planners use this helper for audio, including Claude; this requires an additional OpenAI key and model dependency. Open the sidebar gear to configure **Audio analysis · OpenAI**. This is available alongside external-agent installation views too. The helper key uses session settings, `FILMCRAFT_AUDIO_API_KEY`, saved `audio.apiKey`, then the configured OpenAI key fallback; `FILMCRAFT_AUDIO_MODEL` or saved `audio.model` selects the model (default `gpt-audio-1.5`). A key does not guarantee access to that model. Errors report missing readiness or provider failure without fabricating listening evidence.

For external agents, consume WAV content in an audio-capable model, or call `filmcraft_audio_analyze` and use its attributed text. Read image results in the external LLM, decide the cut positions from that evidence and submit the plan to Jev. The native `audio.read` query is available in both CLI and desktop builds. Audio analysis and Jev plan execution work through desktop and headless API/MCP services with configured provider credentials. Built-in chat routes require the desktop chat launcher.

`GET /v1/chat/providers` includes `audio: {provider:"openai", model, configured, keySource}` without credentials. `POST /v1/chat/config` accepts `provider:"audio"` with `model`, `apiKey` and `persist`; an empty dedicated key clears it, permitting the OpenAI fallback. Environment overrides apply again on restart. Audio data is sent only when a model requests listening; prompts and media can incur provider usage.

For isolated UI validation, run `npm run test:chat-ui -- --out /absolute/disposable/screenshots` and optionally `--project /absolute/fixture.fcproj`. The smoke test copies the fixture into temporary storage, or creates an in-memory demo by default; provider settings, session state and editor data use their own temporary directory. The output directory is preserved. Provider inference in this smoke test is deterministic fixture data.

Provider adapters follow [Claude Messages tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [OpenAI Responses function calling](https://developers.openai.com/api/docs/guides/function-calling), and [TypeSafe Choice function calling](https://docs.typesafe.ai/cookbooks/function_calling). Jev sends `TypeSafe-Danger-Zone-Images: true`, attaches a PNG screenshot when its dimensions satisfy the protocol, and selects tool arguments from enums, defaults, inspected project fields and user-supplied literals. Complex objects must be explicitly supplied in a JSON code block, except single-clip moves and targeted deletions, which have scalar/list adapters. Jev decisions are validated and require confidence ≥0.6. Requests never silently fall back to a different provider.

Jev resolves defaulted settings without a separate presence question and asks whether other optional settings were requested before resolving their values. Argument questions receive the latest request and a compact timeline; action selection retains visual context. Clip IDs are restricted to inspected timeline clips, including when a named ID is invalid. Unambiguous, explicitly named clip IDs and track labels bind directly after inspection confirms them. Single-clip moves preserve omitted position/track and assemble the native move array; targeted deletion explicitly selects the requested clips before deleting. Sequence inspection defaults to the active timeline. Candidate literals come from the latest user message; explicit JSON fields bind directly after type/reference checks and still undergo normal API validation. Ordinary multi-step requests use individual tools; batch commands require explicit JSON steps.

Successful mutations refresh project state and the screenshot. A separate completion question checks the recorded actions, state changes and native verification results. Direct checks cover split boundaries, moves and linked partners, targeted deletion, regular trim duration/start positions, set/adjust gain, program marker name/time, new-title text/track/duration/start, and explicit transition edge/effect/length. Checks compare executed tool arguments against native results; whole-request completion remains a separate model decision. They do not cover every tool, style, or effect property. Failed checks stop the run without replaying the edit. Uncertain completion reports that edits remain applied. Tool errors fail the run; read-only calls may repeat. Export jobs are polled by the controller for up to roughly 90 seconds, checking the returned job ID, terminal result and offline media. A timeout leaves the job running and reports its ID instead of retrying the export.

Only one chat run may edit at a time. Other MCP clients and manual editing can still change the same project. Runs are capped at 40 tool calls, 16 Claude/ChatGPT rounds or 12 Jev actions. Provider requests time out after 120 seconds, are cancellable, and are never automatically retried. Stop cannot roll back completed edits or cancel an already-dispatched engine command/export. Use native Undo and job cancellation tools as appropriate. Switching providers starts a new conversation; histories remain in memory until the launcher exits. Settings also remain in memory unless **Save on this device** is checked. At most 20 sessions and 40 recent runs are retained. The UI sends no provider credential to a model or an MCP tool.

Provider keys and models can also be configured in `config/providers.local.json`. Run `npm run chat:config` from the repository root to create it from [providers.example.json](config/providers.example.json), then fill in the `apiKey` fields. The command never overwrites existing settings and creates new files with mode 0600. Local config files are Git-ignored. Restart `npm run chat` to reload edits. `FILMCRAFT_PROVIDERS_CONFIG` selects an alternative path; a missing explicitly selected file is an error, while a missing default file is optional. The loader validates fields and omits file contents from error messages.

Precedence is session Settings → environment variables → local file → built-in defaults. `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, `OPENAI_API_KEY`/`OPENAI_MODEL`, and `TYPESAFE_API_KEY`/`JEV_MODEL` override the corresponding file entries. `JEV_API_KEY` is accepted when `TYPESAFE_API_KEY` is unset. An explicitly empty environment key disables a file key. With **Save on this device** checked, Apply/Clear writes only the supplied fields to the local JSON file atomically (mode 0600 on Mac/Linux; inherited user-profile permissions on Windows), preserving other providers. The file is not encrypted. Without it, changes affect only the session. Environment overrides still apply after restart. File credentials are passed only to the chat service, not added to the FilmCraft child process environment. Jev's experimental image header stays enabled. Codex and Claude Code continue using their own credentials through their MCP installations.

Desktop mode additionally enables these authenticated routes (disabled in ordinary standalone API mode):

**Debug logging:** In the Assistant sidebar, open Settings, check **Debug logging**, and click **Apply**. It is off by default and configured separately for each provider. **Save on this device** also remembers the logging setting. After a run, **Copy debug log path** copies the path to its local JSONL trace. The trace records provider request bodies and response bodies (including Jev choices, probabilities and confidence), accepted/rejected adapter decisions, tool arguments/results, HTTP status, timing, and the final run status. Failed HTTP responses and malformed JSON are captured too. This records what the provider API returns; it cannot expose internal reasoning that the provider does not return.

Logs contain prompts and project data. Configured API keys and the local API token are redacted; request headers and image/audio payloads are omitted. Logs never upload automatically. Each entry is limited to 2 MiB and each run to 16 MiB, with explicit truncation markers; the latest 20 run files are retained. Files use owner-only permissions on Mac/Linux and inherited profile permissions on Windows. Logging failures appear in the sidebar and run metadata without interrupting editing. Source launches write `artifacts/chat/debug`; installed apps write `debug` under their application data directory. The authenticated run response includes `debug.path`, `debug.error` and `debug.truncated` as applicable. External Codex/Claude Code conversations are not recorded by this mode.

For automation, set `debugLogging: true` in `POST /v1/chat/config` (alongside `provider`, optionally `persist: true`), or in that provider's configuration file object. `JEV_DEBUG_LOGGING=1`, `ANTHROPIC_DEBUG_LOGGING=1`, or `OPENAI_DEBUG_LOGGING=1` enable logging at launch; `0` overrides a saved setting to disable it.

| Endpoint | Purpose |
|---|---|
| `GET /v1/chat/providers` | Models, credential-presence flags, audio-helper readiness and copyable install commands; no keys |
| `POST /v1/chat/config` | Set provider, optional model, API key and debugLogging; empty key removes it; `persist: true` also saves supplied fields locally |
| `POST /v1/chat/runs` | Start a turn: provider, message, optional session UUID and `execution: "direct" \| "jev"` (default direct) |
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
