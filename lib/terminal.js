"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");

function prepareSpawnHelper() {
  if (process.platform === "win32") return;
  const packageDir = path.dirname(require.resolve("node-pty/package.json"));
  const helper = path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  try {
    fs.chmodSync(helper, 0o755);
  } catch {
    // node-pty will report the underlying spawn error if the helper is unavailable.
  }
}

prepareSpawnHelper();

function defaultShell() {
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe";
  return process.env.SHELL || "/bin/sh";
}

class EmbeddedTerminal {
  constructor({
    cwd = os.homedir(),
    cols = 80,
    rows = 24,
    shell = defaultShell(),
    onChange = () => {},
    onExit = () => {},
  } = {}) {
    this.onChange = onChange;
    this.onExit = onExit;
    this.disposed = false;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols,
      convertEol: true,
      rows,
      scrollback: 2000,
    });
    this.pty = pty.spawn(shell, ["-l"], {
      cols,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      name: "xterm-256color",
      rows,
    });
    this.dataDisposable = this.pty.onData((data) => {
      if (this.disposed) return;
      this.terminal.write(data, () => {
        if (!this.disposed) this.onChange();
      });
    });
    this.responseDisposable = this.terminal.onData((data) => {
      if (!this.disposed) this.pty.write(data);
    });
    this.exitDisposable = this.pty.onExit((event) => this.onExit(event));
  }

  write(data) {
    if (!this.disposed) this.pty.write(data);
  }

  resize(cols, rows) {
    if (this.disposed) return;
    this.terminal.resize(cols, rows);
    this.pty.resize(cols, rows);
  }

  screen() {
    const buffer = this.terminal.buffer.active;
    const firstRow = buffer.viewportY || 0;
    const lines = [];
    for (let row = 0; row < this.terminal.rows; row += 1) {
      const line = buffer.getLine(firstRow + row);
      lines.push(line ? line.translateToString(true).trimEnd() : "");
    }
    return {
      cursor: {
        column: buffer.cursorX,
        row: buffer.cursorY,
      },
      lines,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.dataDisposable.dispose();
    this.responseDisposable.dispose();
    this.exitDisposable.dispose();
    this.pty.kill();
    this.terminal.dispose();
  }
}

function createTerminalSession(options) {
  return new EmbeddedTerminal(options);
}

module.exports = { EmbeddedTerminal, createTerminalSession, defaultShell };
