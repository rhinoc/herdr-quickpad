"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SOCKET_FILENAME = "terminal.sock";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function stateDirectory() {
  const directory = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!directory) throw new Error("HERDR_PLUGIN_STATE_DIR is not set");
  return directory;
}

function terminalSocketPath(directory = stateDirectory()) {
  return path.join(directory, SOCKET_FILENAME);
}

function removeSocket(socketPath) {
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probeDaemon(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (running) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(running);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(150, () => finish(false));
  });
}

function launchDaemonWorker() {
  const worker = spawn(
    process.execPath,
    [path.join(__dirname, "..", "index.js"), "daemon-worker"],
    {
      cwd: path.join(__dirname, ".."),
      detached: true,
      env: process.env,
      stdio: "ignore",
    },
  );
  worker.unref();
}

async function ensureTerminalDaemon() {
  const directory = stateDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const socketPath = terminalSocketPath(directory);
  if (await probeDaemon(socketPath)) return;

  removeSocket(socketPath);
  launchDaemonWorker();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await probeDaemon(socketPath)) return;
    await delay(25);
  }
  throw new Error("Quickpad terminal daemon did not start");
}

class TerminalDaemon {
  constructor({ terminalFactory } = {}) {
    this.terminalFactory = terminalFactory || ((options) => {
      const { createTerminalSession } = require("./terminal");
      return createTerminalSession(options);
    });
    this.server = null;
    this.terminal = null;
    this.clients = new Set();
    this.socketPath = terminalSocketPath();
    this.stopping = false;
  }

  async start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (await probeDaemon(this.socketPath)) return false;
    removeSocket(this.socketPath);

    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    process.once("SIGTERM", () => this.stop());
    process.once("SIGINT", () => this.stop());
    return true;
  }

  accept(socket) {
    const client = { socket, attached: false, buffer: "" };
    this.clients.add(client);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      client.buffer += chunk;
      let newline;
      while ((newline = client.buffer.indexOf("\n")) >= 0) {
        const line = client.buffer.slice(0, newline);
        client.buffer = client.buffer.slice(newline + 1);
        this.handleMessage(client, line);
      }
    });
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
  }

  handleMessage(client, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return this.send(client, { type: "error", message: "Invalid terminal daemon message" });
    }

    if (message.type === "attach") {
      client.attached = true;
      this.ensureTerminal(message.cols, message.rows);
      this.send(client, { type: "screen", screen: this.terminal.screen() });
      return;
    }
    if (!client.attached || !this.terminal) return;
    if (message.type === "input") this.terminal.write(message.data || "");
    if (message.type === "resize") this.terminal.resize(message.cols, message.rows);
  }

  ensureTerminal(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    if (this.terminal) {
      this.terminal.resize(cols, rows);
      return;
    }
    this.terminal = this.terminalFactory({
      cols: Math.max(2, Number(cols) || DEFAULT_COLS),
      rows: Math.max(2, Number(rows) || DEFAULT_ROWS),
      cwd: os.homedir(),
      onChange: () => this.broadcastScreen(),
      onExit: ({ exitCode }) => {
        const terminal = this.terminal;
        this.terminal = null;
        terminal?.dispose();
        this.broadcast({ type: "exit", exitCode });
      },
    });
  }

  send(client, message) {
    if (!client.socket.destroyed) client.socket.write(`${JSON.stringify(message)}\n`);
  }

  broadcast(message) {
    for (const client of this.clients) {
      if (client.attached) this.send(client, message);
    }
  }

  broadcastScreen() {
    if (this.terminal) this.broadcast({ type: "screen", screen: this.terminal.screen() });
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.terminal?.dispose();
    this.terminal = null;
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    this.server?.close();
    removeSocket(this.socketPath);
  }
}

async function runTerminalDaemon() {
  const daemon = new TerminalDaemon();
  const started = await daemon.start();
  if (!started) return;
}

module.exports = {
  TerminalDaemon,
  ensureTerminalDaemon,
  runTerminalDaemon,
  terminalSocketPath,
};
