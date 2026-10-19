# Jev FilmCraft desktop distribution

The Mac and Windows downloads contain the patched editor, native CLI, production JavaScript dependencies, and a pinned, SHA-256-verified official Node runtime. Users do not install Rust, Node, npm or a FilmCraft source checkout.

## Install the download

Get the matching ZIP from [Releases](https://github.com/yuyanghu06/jev-filmcraft/releases).

| Computer | Download suffix | Installation |
| --- | --- | --- |
| Mac with Apple Silicon, macOS 13.5+ | `macos-arm64.zip` | Unzip, drag **Jev FilmCraft.app** into Applications, then open it. |
| Mac with Intel, macOS 13.5+ | `macos-x64.zip` | Unzip, drag **Jev FilmCraft.app** into Applications, then open it. |
| Windows 10/11, Intel or AMD x64 | `windows-x64.zip` | Extract the entire **Jev FilmCraft** folder to a permanent location, then double-click **JevFilmCraft.exe**. |

On Windows, keep `bin`, `node`, `runtime` and `Licenses` beside the launcher. Create a shortcut to the launcher if desired. Do not run it inside the ZIP. It uses the .NET Framework included with Windows; no developer tools are required. Windows ARM is not a native target of this preview.

The Mac preview is ad-hoc signed and **not Apple-notarized**. If macOS blocks first launch, use **System Settings → Privacy & Security → Open Anyway** after attempting to open it. See [Apple's instructions](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac). The Windows preview is **unsigned**; SmartScreen may show **More info → Run anyway**. Follow your organization's policy if that choice is unavailable. Do not disable OS security globally.

## Providers and saved settings

Choose a provider in the Assistant sidebar, open its gear/settings button, paste your own API key, and click **Apply**. **Save on this device** is checked by default in packaged builds; uncheck it for session-only changes. No API keys are included in downloads.

| Platform | Saved provider keys |
| --- | --- |
| Mac | `~/Library/Application Support/Jev FilmCraft/providers.json` |
| Windows | `%LOCALAPPDATA%\Jev FilmCraft\providers.json` |

Settings are written atomically outside the installed app, so replacing the app preserves them. The JSON file is **not encrypted**. Mac uses owner-only permissions; Windows inherits your user-profile permissions. Editor preferences, cache and recovery data use the adjacent `editor` directory. The API session file is removed on exit. An API key marked *configured* has been stored; it has not necessarily authenticated successfully. Projects are saved wherever you choose in the editor.

Codex and Claude Code show copyable MCP install commands. Put the app in its permanent location **before** copying a command. Paste it into **PowerShell on Windows** or your terminal on Mac, then restart the agent. These commands use the bundled Node runtime and connect to the open editor's timeline. Recopy the command if you move or rename the app later. Jev's experimental image flag remains enabled.

## Build a release

Initialize the upstream submodule, then install dependencies and run checks:

```sh
git submodule update --init --recursive
npm ci
npm run check
```

On a Mac of the intended architecture with Xcode command-line tools and Rust 1.95+:

```sh
npm run package:mac
npm run test:package
```

On Windows x64 with Rust 1.95+, Visual Studio C++ Build Tools and the Windows SDK:

```powershell
npm run package:windows
npm run test:package
```

Both builders require Node 22+. `JEV_FILMCRAFT_VERSION` sets the release version; the test reads the same variable. `FILMCRAFT_DIR` selects an existing upstream checkout. The build applies the sidebar hook and `distribution.patch`, which removes the restricted upstream wordmark artwork, identifies this community build in About, and directs issue reports here. Downloads include upstream licenses, font/icon attributions, dependency notices, and no user keys or generated media. Windows Rust binaries use a static C runtime.

Outputs are under `artifacts/releases`: ZIP, SHA-256 checksum, build metadata, and staging files. `--skip-build` skips only Cargo compilation; use it only with matching current native release binaries. Mac compilation uses `MACOSX_DEPLOYMENT_TARGET=13.5`; Windows uses `x86_64-pc-windows-msvc` with static CRT.

The **Build desktop previews** GitHub workflow builds Windows x64 and Intel Mac, then tests each extracted package before uploading artifacts. **Build macOS preview** builds either Mac architecture on demand. Workflows do not publish automatically; inspect their reports before creating a release. The Apple Silicon package can also be tested locally on a Mac.

`test:package` extracts to a directory with spaces and an apostrophe, then launches the native app with only operating-system directories on PATH. It runs bundled MCP, performs real timeline editing/render/export, enters a dummy key in the sidebar, restarts to verify persistence, checks clean shutdown, and verifies the installed app is unchanged (codesign on Mac, file hashes on Windows). Mac restart uses Launch Services. Windows CI selects FilmCraft's software renderer through `FILMCRAFT_GRAPHICS=software`; normal launches use the editor's default renderer and fallback logic. Reports and screenshots are under `artifacts/releases/verification`. No live model is called.

`MACOS_SIGN_IDENTITY` can select a builder-supplied identity, but the script does not notarize. Windows packaging currently ships unsigned executables. A public release without these prompts needs owner-supplied platform signing credentials and Mac notarization.
