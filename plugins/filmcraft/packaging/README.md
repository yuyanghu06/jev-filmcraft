# Jev FilmCraft desktop distribution

The macOS package is a standalone `.app` containing the patched editor, native CLI, production JavaScript dependencies, and a pinned, SHA-256-verified official Node runtime. Users do not install Rust, Node, npm or a FilmCraft source checkout. The initial downloadable preview targets Apple Silicon and macOS 13.5 or newer; Intel builds can be produced on an Intel Mac but require separate validation.

## Install the download

1. Download the Mac ZIP from [Releases](https://github.com/yuyanghu06/jev-filmcraft/releases).
2. Unzip it and drag **Jev FilmCraft.app** into **Applications**.
3. Open the app. Choose a provider in the Assistant sidebar, open its gear/settings button, paste your API key, and click **Apply**.
4. **Save on this Mac** is checked by default in packaged builds. Uncheck it for session-only changes.

The preview is ad-hoc signed and **not Apple-notarized**. macOS may block its first launch. For this download, use **System Settings → Privacy & Security → Open Anyway** after attempting to open it. Do not disable Gatekeeper globally. See [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unidentified-developer-mh40616/mac).

Settings live in `~/Library/Application Support/Jev FilmCraft/providers.json`, saved atomically with owner-only permissions. This JSON file is **not encrypted**. The editor preferences, cache and recovery data use the adjacent `editor` directory. The API session file is private, lives outside the app, and is removed on exit. Installing an updated app preserves these files. An API key marked *configured* has been stored; it has not necessarily authenticated successfully.

Codex and Claude Code still show copyable install commands. These commands use the Node runtime inside the installed app and attach to the same live timeline. Move the app to Applications **before** copying a command. Recopy the command if you move or rename the app later. There is no live cloud inference in the packaging smoke test.

## Build a release

Build on a Mac of the intended architecture with Xcode command-line tools, Node 22+ and Rust 1.95+:

```sh
git submodule update --init --recursive
npm ci
npm run check
npm run package:mac
npm run test:package
```

`FILMCRAFT_DIR` selects an existing upstream checkout. `JEV_FILMCRAFT_VERSION` sets the package version. The build applies the sidebar hook and `distribution.patch`, which removes the restricted upstream wordmark artwork, identifies this community build in About, and directs issue reports to this repository. It includes upstream licenses, font/icon attributions, dependency notices, and no user keys or generated media. It never bundles a developer's Homebrew Node executable.

Outputs are under `artifacts/releases`: ZIP, checksum, build metadata, and a local staging app. `--skip-build` skips only Cargo compilation; use it only after compiling the current patched native sources with `MACOSX_DEPLOYMENT_TARGET=13.5`. The default performs the native build. The `Build macOS preview` GitHub workflow produces downloadable build artifacts on demand; it does not publish a release or claim GUI validation.

`test:package` unzips into a different directory containing spaces and launches the native app with only `/usr/bin:/bin` on PATH. It runs the bundled MCP connector, performs real timeline editing/render/export, enters a dummy key through the sidebar, restarts to verify persistence, checks clean shutdown, and verifies the app signature is unchanged. Screenshots and the report are under `artifacts/releases/verification`. It never calls a live model.

The initial preview uses ad-hoc signing because no Developer ID Application identity is configured. `MACOS_SIGN_IDENTITY` can select a builder-supplied identity, but the current script does not notarize. A frictionless public release still needs hardened-runtime signing/entitlements and Apple notarization, using release credentials supplied by the owner. Do not describe these preview ZIPs as notarized or universally compatible with Intel/Windows/Linux.
