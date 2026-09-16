"use strict";

const net = require("node:net");
const { spawnSync } = require("node:child_process");

const PLUGIN_ID = "rhinoc.herdr-quickpad";

function herdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function runHerdr(args) {
  const result = spawnSync(herdrBinary(), args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

function parseJsonOutput(result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Herdr command failed").trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Herdr returned invalid JSON: ${error.message}`);
  }
}

function apiRequest(method, params = {}) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    return Promise.reject(new Error("HERDR_SOCKET_PATH is not set"));
  }

  return new Promise((resolve, reject) => {
    let response = "";
    let settled = false;
    const socket = net.createConnection(socketPath, () => {
      socket.write(
        `${JSON.stringify({
          id: `quickpad-${Date.now()}`,
          method,
          params,
        })}\n`,
      );
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(1500, () => finish(new Error("Herdr API request timed out")));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      const line = response.slice(0, newline).trim();
      try {
        finish(null, JSON.parse(line));
      } catch (error) {
        finish(new Error(`Herdr API returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function snapshot() {
  return parseJsonOutput(runHerdr(["api", "snapshot"]));
}

async function closePopup() {
  const response = await apiRequest("popup.close");
  if (response.error) {
    const error = new Error(response.error.message || "Unable to close the popup");
    error.code = response.error.code;
    throw error;
  }
  return response;
}

function openQuickpad() {
  const result = runHerdr([
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    "quickpad",
  ]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Unable to open Quickpad").trim());
  }
}

function toggleFromAction() {
  return closePopup()
    .catch((error) => {
      if (error.code !== "popup_not_open") throw error;
      openQuickpad();
    });
}

module.exports = {
  PLUGIN_ID,
  closePopup,
  openQuickpad,
  snapshot,
  toggleFromAction,
};
