import test from 'node:test';
import assert from 'node:assert/strict';
import { installCommands } from '../src/chat/desktop.js';

test('MCP installation commands quote installed paths for the destination shell', () => {
  const windows = installCommands({ FILMCRAFT_LAUNCHER: "C:\\Users\\O'Brien\\Jev FilmCraft\\runtime\\launch.mjs" }, 'win32');
  assert(windows.codex.includes("'C:\\Users\\O''Brien\\Jev FilmCraft\\runtime\\launch.mjs' desktop-mcp"));
  assert(windows['claude-code'].startsWith('claude mcp add --scope user --transport stdio filmcraft -- '));
  const mac = installCommands({ FILMCRAFT_LAUNCHER: "/Applications/O'Brien/Jev FilmCraft.app/Contents/Resources/runtime/launch.mjs" }, 'darwin');
  assert(mac.codex.includes("/O'\\''Brien/"));
});
