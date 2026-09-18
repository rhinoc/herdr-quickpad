"use strict";

const { spawnSync } = require("node:child_process");

function providers() {
  if (process.platform === "darwin") {
    return [{ read: ["pbpaste", []], write: ["pbcopy", []] }];
  }
  if (process.platform === "linux") {
    return [
      { read: ["wl-paste", []], write: ["wl-copy", []] },
      { read: ["xclip", ["-selection", "clipboard"]], write: ["xclip", ["-selection", "clipboard"]] },
      { read: ["xsel", ["--clipboard", "--output"]], write: ["xsel", ["--clipboard", "--input"]] },
    ];
  }
  return [];
}

function run(command, args, input) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || `${command} exited with ${result.status}`).trim());
  }
  return result.stdout || "";
}

function write(text) {
  let lastError;
  for (const provider of providers()) {
    try {
      run(provider.write[0], provider.write[1], String(text));
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No supported clipboard provider found");
}

function read() {
  let lastError;
  for (const provider of providers()) {
    try {
      return run(provider.read[0], provider.read[1]);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No supported clipboard provider found");
}

module.exports = { read, write };
