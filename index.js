"use strict";

const { toggleFromAction } = require("./lib/api");
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
  throw new Error("usage: node index.js <toggle|ui>");
}

main().catch((error) => {
  process.stderr.write(`herdr-quickpad: ${error.message}\n`);
  process.exit(1);
});
