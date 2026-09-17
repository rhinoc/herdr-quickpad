"use strict";

const { toggleFromAction } = require("./lib/api");
const { ensureTerminalDaemon, runTerminalDaemon } = require("./lib/terminal-daemon");
const { startUi } = require("./lib/ui");

async function main() {
  const command = process.argv[2];
  if (command === "toggle") {
    await toggleFromAction();
    return;
  }
  if (command === "ui") {
    startUi();
    return;
  }
  if (command === "daemon") {
    await ensureTerminalDaemon();
    return;
  }
  if (command === "daemon-worker") {
    await runTerminalDaemon();
    return;
  }
  throw new Error("usage: node index.js <toggle|ui>");
}

main().catch((error) => {
  process.stderr.write(`herdr-quickpad: ${error.message}\n`);
  process.exit(1);
});
