"use strict";

const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
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

class PersistentTerminalClient {
  constructor({
    cols = 80,
    rows = 24,
    onChange = () => {},
    onExit = () => {},
    onError = () => {},
  } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.onChange = onChange;
    this.onExit = onExit;
    this.onError = onError;
    this.socket = null;
    this.buffer = "";
    this.pending = [];
    this.disposed = false;
    this.screenState = {
      cursor: { column: 0, row: 0 },
      lines: Array.from({ length: rows }, () => ""),
    };
    this.connect();
  }

  async connect() {
    try {
      const { ensureTerminalDaemon, terminalSocketPath } = require("./terminal-daemon");
      await ensureTerminalDaemon();
      if (this.disposed) return;
      const socket = net.createConnection(terminalSocketPath());
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        if (this.disposed) return socket.destroy();
        this.socket = socket;
        this.send({ type: "attach", cols: this.cols, rows: this.rows });
        this.pending.splice(0).forEach((message) => this.send(message));
      });
      socket.on("data", (chunk) => this.receive(chunk));
      socket.on("error", (error) => {
        if (!this.disposed) this.onError(error);
      });
      socket.on("close", () => {
        if (!this.disposed && this.socket === socket) {
          this.socket = null;
          this.onError(new Error("Quickpad terminal daemon disconnected"));
        }
      });
    } catch (error) {
      if (!this.disposed) this.onError(error);
    }
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.onError(new Error("Quickpad terminal daemon returned invalid data"));
        continue;
      }
      if (message.type === "screen") {
        this.screenState = message.screen;
        this.onChange();
      } else if (message.type === "exit") {
        this.onExit({ exitCode: message.exitCode });
      } else if (message.type === "error") {
        this.onError(new Error(message.message));
      }
    }
  }

  send(message) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify(message)}\n`);
    } else {
      this.pending.push(message);
    }
  }

  write(data) {
    if (!this.disposed) this.send({ type: "input", data });
  }

  resize(cols, rows) {
    if (this.disposed) return;
    this.cols = cols;
    this.rows = rows;
    this.send({ type: "resize", cols, rows });
  }

  screen() {
    return this.screenState;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];
    this.socket?.end();
    this.socket = null;
  }
}

function createTerminalSession(options) {
  return new EmbeddedTerminal(options);
}

function createPersistentTerminalSession(options) {
  return new PersistentTerminalClient(options);
}

module.exports = {
  EmbeddedTerminal,
  PersistentTerminalClient,
  createPersistentTerminalSession,
  createTerminalSession,
  defaultShell,
};
