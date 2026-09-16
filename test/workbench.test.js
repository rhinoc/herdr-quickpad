"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { InputDecoder, csiEvent } = require("../lib/input");
const { readNote, writeNote } = require("../lib/state");
const { WorkbenchUi } = require("../lib/ui");

test("decodes cmd+j Kitty CSI-u variants as toggle", () => {
  assert.deepEqual(csiEvent("\x1b[106;9u"), { type: "toggle" });
  assert.deepEqual(csiEvent("\x1b[106;9:1u"), { type: "toggle" });
  assert.deepEqual(csiEvent("\x1b[106;9;106u"), { type: "toggle" });
  assert.deepEqual(csiEvent("\x1b[106;9:1;106u"), { type: "toggle" });
});

test("decodes Escape in Kitty and modifyOtherKeys forms", () => {
  assert.deepEqual(csiEvent("\x1b[27;1:1u"), { type: "escape" });
  assert.deepEqual(csiEvent("\x1b[27;1;27~"), { type: "escape" });
});

test("decodes SGR mouse clicks", () => {
  assert.deepEqual(csiEvent("\x1b[<0;4;2M"), {
    type: "mouse",
    action: "press",
    button: 0,
    column: 3,
    row: 1,
  });
  assert.deepEqual(csiEvent("\x1b[<0;4;2m"), {
    type: "mouse",
    action: "release",
    button: 0,
    column: 3,
    row: 1,
  });
});

test("decodes REPORT_ALL_KEYS text, controls, and navigation", () => {
  assert.deepEqual(csiEvent("\x1b[97;1:1;97u"), { type: "text", value: "a" });
  assert.deepEqual(csiEvent("\x1b[65:97;2:1;65u"), { type: "text", value: "A" });
  assert.deepEqual(csiEvent("\x1b[57419;1:1u"), { type: "up" });
  assert.deepEqual(csiEvent("\x1b[116;5:1;116u"), { type: "switch-tab" });
  assert.deepEqual(csiEvent("\x1b[106;1:3u"), { type: "unknown" });
});

test("decodes both Kitty CSI-u Backspace encodings", () => {
  assert.deepEqual(csiEvent("\x1b[8;1:1u"), { type: "backspace" });
  assert.deepEqual(csiEvent("\x1b[127;1:1u"), { type: "backspace" });
  assert.deepEqual(csiEvent("\x1b[127;1:1;8:127u"), { type: "backspace" });
  assert.deepEqual(csiEvent("\x1b[8;1:3u"), { type: "unknown" });
});

test("decodes Backspace from modifyOtherKeys and enhanced legacy forms", () => {
  assert.deepEqual(csiEvent("\x1b[27;1;127~"), { type: "backspace" });
  assert.deepEqual(csiEvent("\x1b[127;1~"), { type: "backspace" });
});

test("decodes enhanced legacy Delete sequences", () => {
  assert.deepEqual(csiEvent("\x1b[3;1:1~"), { type: "delete" });
  assert.deepEqual(csiEvent("\x1b[3;1:2~"), { type: "delete" });
  assert.deepEqual(csiEvent("\x1b[3;1:3~"), { type: "unknown" });
});

test("decodes split input without leaking cmd+j", () => {
  const decoder = new InputDecoder();
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[106;")), []);
  assert.deepEqual(decoder.feed(Buffer.from("9u")), [{ type: "toggle" }]);
});

test("keeps ordinary note text and control keys", () => {
  const decoder = new InputDecoder();
  assert.deepEqual(decoder.feed(Buffer.from("abc\r\x7f\x13")), [
    { type: "text", value: "a" },
    { type: "text", value: "b" },
    { type: "text", value: "c" },
    { type: "enter" },
    { type: "backspace" },
  ]);
});

test("decodes ctrl+t as the tab switching command", () => {
  const decoder = new InputDecoder();
  assert.deepEqual(decoder.feed(Buffer.from("\x14")), [{ type: "switch-tab" }]);
  assert.deepEqual(csiEvent("\x1b[110;5:1u"), { type: "unknown" });
});

test("supports Delete and tab switching", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const terminal = {
      dispose() {},
      resize() {},
      screen() {
        return { cursor: { column: 0, row: 0 }, lines: [""] };
      },
      write() {},
    };
    const ui = new WorkbenchUi({ terminalFactory: () => terminal });
    ui.noteLines = ["abcd"];
    ui.noteRow = 0;
    ui.noteColumn = 1;
    ui.handleNotes({ type: "delete" });
    assert.deepEqual(ui.noteLines, ["acd"]);

    ui.handleTerminal({ type: "switch-tab" });
    assert.equal(ui.activeTab, "notes");
    ui.handleMouse({ type: "mouse", action: "press", button: 0, column: 12, row: 0 });
    assert.equal(ui.activeTab, "terminal");
    ui.handleMouse({ type: "mouse", action: "press", button: 0, column: 3, row: 0 });
    assert.equal(ui.activeTab, "notes");
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("auto-saves notes after edits", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const ui = new WorkbenchUi();
    ui.noteLines = ["abcd"];
    ui.noteRow = 0;
    ui.noteColumn = 2;

    ui.handleNotes({ type: "text", value: "X" });
    assert.equal(readNote(stateDir), "abXcd");
    ui.handleNotes({ type: "backspace" });
    assert.equal(readNote(stateDir), "abcd");
    ui.handleNotes({ type: "enter" });
    assert.equal(readNote(stateDir), "ab\ncd");
    assert.equal(ui.status, "");
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("Ctrl+T opens one embedded home-directory shell", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const created = [];
    const terminal = {
      dispose() {},
      resize() {},
      screen() {
        return { cursor: { column: 0, row: 0 }, lines: [""] };
      },
      write() {},
    };
    const ui = new WorkbenchUi({
      terminalFactory: (params) => {
        created.push(params);
        return terminal;
      },
    });
    ui.handleNotes({ type: "switch-tab" });
    assert.equal(ui.activeTab, "terminal");
    assert.equal(ui.terminalCwd, os.homedir());
    assert.equal(created.length, 1);
    assert.equal(created[0].cwd, os.homedir());
    ui.handleTerminal({ type: "switch-tab" });
    assert.equal(ui.activeTab, "notes");
    ui.handleNotes({ type: "switch-tab" });
    assert.equal(ui.activeTab, "terminal");
    assert.equal(created.length, 1);
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("embedded terminal receives raw input and Ctrl+T returns to notes", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const written = [];
    const terminal = {
      dispose() {},
      resize() {},
      screen() {
        return { cursor: { column: 0, row: 0 }, lines: [""] };
      },
      write(value) {
        written.push(value);
      },
    };
    const ui = new WorkbenchUi({ terminalFactory: () => terminal });
    ui.handleNotes({ type: "switch-tab" });
    ui.handleInput(Buffer.from("echo hello\r"));
    assert.deepEqual(written, ["echo hello\r"]);
    ui.handleInput(Buffer.from("\x14"));
    assert.equal(ui.activeTab, "notes");
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("persists one global note across workspaces", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));

  writeNote(stateDir, "global note");

  assert.equal(readNote(stateDir), "global note");
});

test("migrates the most recently updated workspace note", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  fs.writeFileSync(path.join(stateDir, "workspaces.json"), JSON.stringify({
    version: 1,
    workspaces: {
      old: { note: "old note", updated_at: "2026-01-01T00:00:00.000Z" },
      current: { note: "current note", updated_at: "2026-02-01T00:00:00.000Z" },
      empty: { note: "", updated_at: "2026-03-01T00:00:00.000Z" },
    },
  }));

  assert.equal(readNote(stateDir), "current note");
});
