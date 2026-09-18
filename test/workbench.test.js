"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { InputDecoder, csiEvent } = require("../lib/input");
const { renderMarkdownLine, renderMarkdownLineWithCursor, safeText } = require("../lib/markdown");
const { readActiveTab, readNote, writeActiveTab, writeNote } = require("../lib/state");
const { displayWidth } = require("../lib/terminal-width");
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
  assert.deepEqual(csiEvent("\x1b[<32;6;3M"), {
    type: "mouse",
    action: "press",
    button: 0,
    column: 5,
    row: 2,
    motion: true,
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

test("renders Markdown syntax inline while keeping the source editable", () => {
  const checklist = safeText(renderMarkdownLine("- [ ] Ship **today**"));
  assert.match(checklist, /\u{f0131} Ship today/u);
  assert.doesNotMatch(checklist, /\[ \]/);

  const compactChecklist = safeText(renderMarkdownLine("-[] Ship"));
  assert.equal(compactChecklist, "\u{f0131} Ship");
  const compactChecked = safeText(renderMarkdownLine("-[x] Done"));
  assert.equal(compactChecked, "\u{f0c52} Done");

  const heading = safeText(renderMarkdownLine("## Quickpad"));
  assert.equal(heading, "Quickpad");

  const editing = safeText(renderMarkdownLine("- [ ] Ship **today**", { cursorColumn: 3, raw: true }));
  assert.match(editing, /- \[ \]/);

  const renderedAtCursor = safeText(renderMarkdownLine("**bold**", { cursorColumn: 8 }));
  assert.equal(renderedAtCursor, "bold");
  const editingToken = safeText(renderMarkdownLine("**bold**", { cursorColumn: 2 }));
  assert.equal(editingToken, "**bold**");
  const raw = renderMarkdownLineWithCursor("**bold**", { cursorColumn: 8, raw: true });
  assert.equal(safeText(raw.text), "**bold**");
  assert.equal(raw.cursorColumn, 8);

  const cursor = renderMarkdownLineWithCursor("abcd", { cursorColumn: 2 });
  assert.equal(safeText(cursor.text), "abcd");
  assert.equal(cursor.cursorColumn, 2);

  const selected = renderMarkdownLineWithCursor("abcd", { selectionStart: 0, selectionEnd: 4 });
  assert.match(selected.text, /\x1b\[7m/);

  const checklistCursor = renderMarkdownLineWithCursor("- [ ] Ship", { cursorColumn: 7 });
  assert.equal(safeText(checklistCursor.text), "\u{f0131} Ship");
  assert.equal(checklistCursor.cursorColumn, 3);
});

test("maps terminal columns using cell width and visible Markdown content", () => {
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("😀a"), 3);

  const wideText = renderMarkdownLineWithCursor("中文a", { cursorColumn: 2 });
  assert.equal(wideText.cursorColumn, 4);

  const boldText = renderMarkdownLineWithCursor("**bold**", { displayColumn: 0 });
  assert.equal(boldText.sourceColumn, 2);
  const boldEnd = renderMarkdownLineWithCursor("**bold**", { displayColumn: 4 });
  assert.equal(boldEnd.sourceColumn, 8);

  const checklist = renderMarkdownLineWithCursor("- [ ] Ship", { displayColumn: 0 });
  assert.equal(checklist.sourceColumn, 6);
});

test("moves and deletes whole graphemes without splitting emoji", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const ui = new WorkbenchUi();
    ui.noteLines = ["😀a"];
    ui.noteRow = 0;
    ui.noteColumn = ui.noteLines[0].length;

    ui.handleNotes({ type: "left" });
    assert.equal(ui.noteColumn, 2);
    ui.handleNotes({ type: "backspace" });
    assert.deepEqual(ui.noteLines, ["a"]);
    assert.equal(ui.noteColumn, 0);
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("decodes ctrl+t as the tab switching command", () => {
  const decoder = new InputDecoder();
  assert.deepEqual(decoder.feed(Buffer.from("\x14")), [{ type: "switch-tab" }]);
  assert.deepEqual(csiEvent("\x1b[113;5:1u"), { type: "unknown" });
});

test("decodes common command and control editing shortcuts", () => {
  assert.deepEqual(csiEvent("\x1b[97;9u"), { type: "select-all" });
  assert.deepEqual(csiEvent("\x1b[99;9u"), { type: "copy" });
  assert.deepEqual(csiEvent("\x1b[118;9u"), { type: "paste" });
  assert.deepEqual(csiEvent("\x1b[120;9u"), { type: "cut" });
  assert.deepEqual(csiEvent("\x1b[122;9u"), { type: "undo" });
  assert.deepEqual(csiEvent("\x1b[122;10u"), { type: "redo" });
  assert.deepEqual(csiEvent("\x1b[117;5:1u"), { type: "delete-to-start" });
  assert.deepEqual(csiEvent("\x1b[107;5:1u"), { type: "delete-to-end" });
  assert.deepEqual(csiEvent("\x1b[119;5:1u"), { type: "delete-word" });
  assert.deepEqual(csiEvent("\x1b[100;5:1u"), { type: "delete" });
  assert.deepEqual(csiEvent("\x1b[98;5:1u"), { type: "left" });
  assert.deepEqual(csiEvent("\x1b[99;5:1u"), { type: "interrupt" });

  const decoder = new InputDecoder();
  assert.deepEqual(decoder.feed(Buffer.from("\x04\x0b\x15\x17\x02\x06\x10\x0e")), [
    { type: "delete" },
    { type: "delete-to-end" },
    { type: "delete-to-start" },
    { type: "delete-word" },
    { type: "left" },
    { type: "right" },
    { type: "up" },
    { type: "down" },
  ]);
});

test("Ctrl+C clears all Notes content and can be undone", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const ui = new WorkbenchUi();
    ui.noteLines = ["first", "second"];
    ui.noteRow = 1;
    ui.noteColumn = 3;
    ui.history = [];
    ui.historyIndex = -1;
    ui.recordHistory();

    ui.handleNotes({ type: "interrupt" });
    assert.deepEqual(ui.noteLines, [""]);
    assert.equal(ui.noteRow, 0);
    assert.equal(ui.noteColumn, 0);
    assert.equal(readNote(stateDir), "");

    ui.handleNotes({ type: "undo" });
    assert.deepEqual(ui.noteLines, ["first", "second"]);
    assert.equal(readNote(stateDir), "first\nsecond");
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
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
    assert.equal(readActiveTab(stateDir), "notes");
    ui.handleMouse({ type: "mouse", action: "press", button: 0, column: 12, row: 0 });
    assert.equal(ui.activeTab, "terminal");
    assert.equal(readActiveTab(stateDir), "terminal");
    ui.handleMouse({ type: "mouse", action: "press", button: 0, column: 3, row: 0 });
    assert.equal(ui.activeTab, "notes");
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("restores the last active tab when Quickpad reopens", () => {
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
    const created = [];
    const terminalFactory = (params) => {
      created.push(params);
      return terminal;
    };
    const firstUi = new WorkbenchUi({ terminalFactory });
    firstUi.handleNotes({ type: "switch-tab" });
    assert.equal(readActiveTab(stateDir), "terminal");

    const reopenedUi = new WorkbenchUi({ terminalFactory });
    assert.equal(reopenedUi.activeTab, "terminal");
    assert.equal(reopenedUi.terminalSession, terminal);
    assert.equal(created.length, 2);

    reopenedUi.handleTerminal({ type: "switch-tab" });
    assert.equal(reopenedUi.activeTab, "notes");
    assert.equal(readActiveTab(stateDir), "notes");
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("restored terminal starts with terminal keyboard protocol", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    writeActiveTab(stateDir, "terminal");
    const terminal = {
      dispose() {},
      resize() {},
      screen() {
        return { cursor: { column: 0, row: 0 }, lines: [""] };
      },
      write() {},
    };
    const ui = new WorkbenchUi({ terminalFactory: () => terminal });
    const originalWrite = process.stdout.write;
    const originalSetRawMode = process.stdin.setRawMode;
    const output = [];

    process.stdout.write = (value) => {
      output.push(String(value));
      return true;
    };
    process.stdin.setRawMode = () => process.stdin;
    ui.render = () => {};

    try {
      ui.start();
      assert.equal(ui.activeTab, "terminal");
      assert.equal(ui.keyboardProtocolEnabled, false);
      assert.deepEqual(output, [
        "\x1b[>31u\x1b[?1002h\x1b[?1006h",
        "\x1b[<1u",
      ]);
    } finally {
      process.stdin.off("data", ui.onData);
      process.stdin.off("end", ui.onEnd);
      process.stdout.off("resize", ui.onResize);
      process.stdout.write = originalWrite;
      if (originalSetRawMode) process.stdin.setRawMode = originalSetRawMode;
      else delete process.stdin.setRawMode;
      process.stdin.pause();
    }
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

test("copies, pastes, cuts, undoes, and handles control editing in Notes", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const clipboard = {
      value: "",
      write(value) {
        this.value = value;
      },
      read() {
        return this.value;
      },
    };
    const ui = new WorkbenchUi({ clipboard });
    ui.noteLines = ["hello world"];
    ui.noteRow = 0;
    ui.noteColumn = 5;
    ui.history = [];
    ui.historyIndex = -1;
    ui.recordHistory();

    ui.handleNotes({ type: "select-all" });
    ui.handleNotes({ type: "copy" });
    assert.equal(clipboard.value, "hello world");

    clipboard.value = "replacement";
    ui.handleNotes({ type: "paste" });
    assert.equal(readNote(stateDir), "replacement");
    ui.handleNotes({ type: "undo" });
    assert.equal(readNote(stateDir), "hello world");
    ui.handleNotes({ type: "redo" });
    assert.equal(readNote(stateDir), "replacement");

    ui.noteLines = ["hello world"];
    ui.noteRow = 0;
    ui.noteColumn = 5;
    ui.clearSelection();
    ui.handleNotes({ type: "delete-to-start" });
    assert.deepEqual(ui.noteLines, [" world"]);
    ui.noteColumn = 1;
    ui.handleNotes({ type: "delete-to-end" });
    assert.deepEqual(ui.noteLines, [" "]);

    ui.noteLines = ["one two"];
    ui.noteRow = 0;
    ui.noteColumn = 7;
    ui.handleNotes({ type: "delete-word" });
    assert.deepEqual(ui.noteLines, ["one"]);

    ui.handleNotes({ type: "copy" });
    assert.equal(clipboard.value, "one");
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("routes Cmd+A through the live Notes input path and renders the selection", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const originalWrite = process.stdout.write;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const output = [];
    process.stdout.write = (value) => {
      output.push(String(value));
      return true;
    };
    const ui = new WorkbenchUi();
    ui.noteLines = ["hello", "world"];
    ui.noteRow = 1;
    ui.noteColumn = 5;

    await ui.handleInput(Buffer.from("\x1b[97;9u"));

    assert.deepEqual(ui.selectionRange(), { start: 0, end: 11 });
    assert.match(output.join(""), /\x1b\[7m/);
  } finally {
    process.stdout.write = originalWrite;
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("renders Markdown on active and inactive note lines", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  const originalWrite = process.stdout.write;
  const output = [];

  try {
    process.stdout.write = (value) => {
      output.push(String(value));
      return true;
    };
    const ui = new WorkbenchUi();
    ui.noteLines = ["**active**", "**rendered**"];
    ui.noteRow = 0;
    ui.noteColumn = ui.noteLines[0].length;
    ui.render();

    const visible = safeText(output.join(""));
    assert.doesNotMatch(visible, /\*\*active\*\*/);
    assert.match(visible, /active/);
    assert.match(visible, /rendered/);
    assert.doesNotMatch(visible, /\*\*rendered\*\*/);
  } finally {
    process.stdout.write = originalWrite;
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("selects note text with a mouse drag", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));
  const previousStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;

  try {
    const ui = new WorkbenchUi();
    ui.noteLines = ["first line", "second line"];
    ui.noteRow = 1;
    ui.noteColumn = 11;

    assert.equal(ui.handleMouse({ type: "mouse", action: "press", button: 0, column: 2, row: 1 }), true);
    assert.equal(ui.mouseSelectionActive, true);
    assert.equal(ui.noteRow, 0);
    assert.equal(ui.noteColumn, 2);

    assert.equal(ui.handleMouse({
      type: "mouse",
      action: "press",
      button: 0,
      column: 4,
      row: 2,
      motion: true,
    }), true);
    assert.deepEqual(ui.selectionRange(), { start: 2, end: 15 });

    assert.equal(ui.handleMouse({ type: "mouse", action: "release", button: 0, column: 4, row: 2 }), true);
    assert.equal(ui.mouseSelectionActive, false);
    assert.equal(ui.selectedText(), "rst line\nseco");
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
    ui.handleInput(Buffer.from("\x1b[<0;3;3M\x1b[<32;4;3M\x1b[<0;4;3m"));
    ui.handleInput(Buffer.from("\x15"));
    ui.handleInput(Buffer.from("\x1b[117;5:1u"));
    ui.handleInput(Buffer.from("\x1b[107;5:1u"));
    assert.deepEqual(written, ["echo hello\r", "\x15", "\x15", "\x0b"]);
    ui.handleInput(Buffer.from("\x14"));
    assert.equal(ui.activeTab, "notes");
  } finally {
    if (previousStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousStateDir;
  }
});

test("cmd+j toggles from the embedded terminal without reaching the shell", () => {
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
    let toggles = 0;
    ui.close = () => {
      toggles += 1;
    };

    ui.handleInput(Buffer.from("\x1b[106;9u"));

    assert.equal(toggles, 1);
    assert.deepEqual(written, []);
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

test("persists the active tab independently from the note", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-quickpad-"));

  assert.equal(readActiveTab(stateDir), "notes");
  writeNote(stateDir, "global note");
  writeActiveTab(stateDir, "terminal");

  assert.equal(readNote(stateDir), "global note");
  assert.equal(readActiveTab(stateDir), "terminal");
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
