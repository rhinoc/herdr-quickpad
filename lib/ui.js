"use strict";

const os = require("node:os");
const { closePopup } = require("./api");
const systemClipboard = require("./clipboard");
const { InputDecoder, csiEvent } = require("./input");
const { renderMarkdownLineWithCursor } = require("./markdown");
const { readActiveTab, readNote, writeActiveTab, writeNote } = require("./state");
const { createPersistentTerminalSession } = require("./terminal");
const {
  displayWidth,
  firstGrapheme,
  graphemeWidth,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
} = require("./terminal-width");

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const KITTY_KEYBOARD_PUSH = "\x1b[>31u";
const KITTY_KEYBOARD_POP = "\x1b[<1u";
const MOUSE_PUSH = "\x1b[?1002h\x1b[?1006h";
const MOUSE_POP = "\x1b[?1006l\x1b[?1002l";
const NOTES_TAB = { start: 0, end: 9 };
const TERMINAL_TAB = { start: 11, end: 23 };
const TERMINAL_CONTROL_BYTES = {
  backspace: "\x7f",
  delete: "\x04",
  "delete-to-end": "\x0b",
  "delete-to-start": "\x15",
  "delete-word": "\x17",
  interrupt: "\x03",
};

function clip(value, width) {
  const plain = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (displayWidth(plain) <= width) return value;

  let visible = 0;
  let index = 0;
  let output = "";
  while (index < value.length && visible < Math.max(0, width - 1)) {
    if (value[index] === "\x1b") {
      const match = value.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    const character = firstGrapheme(value.slice(index));
    if (!character) break;
    const characterWidth = graphemeWidth(character, visible);
    if (visible + characterWidth > Math.max(0, width - 1)) break;
    output += character;
    index += character.length;
    visible += characterWidth;
  }
  return `${output}…${RESET}`;
}

function contextFromEnv() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function tabLabel(label, active, width) {
  const text = active ? `[ ${label} ]` : `  ${label}  `;
  return text.padEnd(width, " ");
}

class WorkbenchUi {
  constructor({ terminalFactory = createPersistentTerminalSession, clipboard = systemClipboard } = {}) {
    this.context = contextFromEnv();
    this.stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    if (!this.stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set");
    this.noteLines = readNote(this.stateDir).split("\n");
    this.activeTab = "notes";
    this.noteRow = this.noteLines.length - 1;
    this.noteColumn = this.noteLines[this.noteRow].length;
    this.clipboard = clipboard;
    this.selectionAnchor = null;
    this.mouseSelectionActive = false;
    this.history = [];
    this.historyIndex = -1;
    this.recordHistory();
    this.terminalFactory = terminalFactory;
    this.terminalSession = null;
    this.terminalCwd = null;
    this.status = "";
    this.decoder = new InputDecoder();
    this.closing = false;
    this.started = false;
    this.keyboardProtocolEnabled = false;
    this.mouseProtocolEnabled = false;

    if (readActiveTab(this.stateDir) === "terminal") this.openTerminalTab();
  }

  start() {
    // Keep Cmd/Control/Alt key identity inside the popup. Without this,
    // Cmd+j can be reduced to a plain `j` before the plugin receives it.
    process.stdout.write(KITTY_KEYBOARD_PUSH + MOUSE_PUSH);
    this.keyboardProtocolEnabled = true;
    this.mouseProtocolEnabled = true;
    this.started = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.onData = (chunk) => this.handleInput(chunk);
    this.onResize = () => {
      this.resizeTerminal();
      this.render();
    };
    process.stdin.on("data", this.onData);
    this.onEnd = () => this.stop();
    process.stdin.on("end", this.onEnd);
    process.stdout.on("resize", this.onResize);
    if (this.activeTab === "terminal") this.enterTerminalMode();
    this.render();
  }

  handleInput(chunk) {
    if (this.activeTab === "terminal") return this.handleTerminalInput(chunk.toString("utf8"));
    return this.handle(this.decoder.feed(chunk));
  }

  handleTerminalInput(chunk) {
    const mouseSequence = /\x1b\[<\d+;\d+;\d+[Mm]/g;
    let match;
    let offset = 0;
    let foundMouse = false;
    while ((match = mouseSequence.exec(chunk))) {
      foundMouse = true;
      if (match.index > offset) this.handleTerminalInput(chunk.slice(offset, match.index));
      this.handleMouse(csiEvent(match[0]));
      offset = match.index + match[0].length;
    }
    if (foundMouse) {
      if (offset < chunk.length) this.handleTerminalInput(chunk.slice(offset));
      return;
    }

    const event = csiEvent(chunk);
    if (event.type === "mouse") {
      if (this.handleMouse(event)) return;
      return;
    }
    if (event.type === "toggle") return this.close();
    if (event.type === "escape" || chunk === "\x1b") return this.close();
    if (event.type === "switch-tab") return this.selectTab("notes");

    const switchTabIndex = chunk.indexOf("\x14");
    if (switchTabIndex >= 0) {
      if (switchTabIndex > 0) this.terminalSession?.write(chunk.slice(0, switchTabIndex));
      return this.selectTab("notes");
    }

    const controlByte = TERMINAL_CONTROL_BYTES[event.type];
    if (controlByte && chunk.startsWith("\x1b[")) {
      return this.terminalSession?.write(controlByte);
    }

    this.terminalSession?.write(chunk);
  }

  async handle(events) {
    for (const event of events) {
      if (event.type === "toggle") return this.close();
      if (event.type === "escape") return this.close();
      if (event.type === "mouse") {
        this.handleMouse(event);
        continue;
      }
      if (this.activeTab === "notes") this.handleNotes(event);
      else this.handleTerminal(event);
      if (this.closing) return;
    }
    this.render();
  }

  handleMouse(event) {
    if (event.action === "press" && !event.motion && event.row === 0) {
      if (event.column >= NOTES_TAB.start && event.column < NOTES_TAB.end) {
        this.selectTab("notes");
        return true;
      }
      if (event.column >= TERMINAL_TAB.start && event.column < TERMINAL_TAB.end) {
        this.openTerminalTab();
        return true;
      }
    }

    if (this.activeTab !== "notes" || event.button !== 0) return false;

    if (event.action === "press" && !event.motion) {
      const location = this.noteLocationFromMouse(event);
      if (!location) return false;
      this.noteRow = location.row;
      this.noteColumn = location.column;
      this.selectionAnchor = this.noteOffset();
      this.mouseSelectionActive = true;
      this.status = "";
      return true;
    }

    if (event.motion && this.mouseSelectionActive) {
      const location = this.noteLocationFromMouse(event);
      if (!location) return true;
      this.noteRow = location.row;
      this.noteColumn = location.column;
      return true;
    }

    if (event.action === "release" && this.mouseSelectionActive) {
      const location = this.noteLocationFromMouse(event);
      if (location) {
        this.noteRow = location.row;
        this.noteColumn = location.column;
      }
      this.mouseSelectionActive = false;
      return true;
    }

    return false;
  }

  handleNotes(event) {
    if (event.type === "switch-tab") return this.openTerminalTab();
    if (event.type === "select-all") return this.selectAllNote();
    if (event.type === "copy") return this.copyNote();
    if (event.type === "interrupt") return this.clearAllNote();
    if (event.type === "cut") return this.cutNote();
    if (event.type === "paste") return this.pasteNote();
    if (event.type === "undo") return this.undoNote();
    if (event.type === "redo") return this.redoNote();
    if (event.type === "up") return this.moveNote(-1, 0, event.shift);
    if (event.type === "down") return this.moveNote(1, 0, event.shift);
    if (event.type === "left") return this.moveNote(0, -1, event.shift);
    if (event.type === "right") return this.moveNote(0, 1, event.shift);
    if (event.type === "home") return this.moveNoteTo(0, event.shift);
    if (event.type === "end") return this.moveNoteTo(this.noteLines[this.noteRow].length, event.shift);
    if (event.type === "delete-to-start") return this.deleteToStart();
    if (event.type === "delete-to-end") return this.deleteToEnd();
    if (event.type === "delete-word") return this.deleteWord();
    if (event.type === "enter") return this.splitNoteLine();
    if (event.type === "backspace") return this.backspaceNote();
    if (event.type === "delete") return this.deleteNoteCharacter();
    if (event.type === "text") {
      return this.replaceSelection(event.value);
    }
  }

  handleTerminal(event) {
    if (event.type === "escape") return this.close();
    if (event.type === "switch-tab") return this.selectTab("notes");
  }

  openTerminalTab() {
    if (this.terminalSession) {
      return this.selectTab("terminal");
    }

    try {
      const { cols, rows } = this.terminalSize();
      this.terminalSession = this.terminalFactory({
        cols,
        onChange: () => {
          if (this.activeTab === "terminal") this.render();
        },
        onExit: ({ exitCode }) => {
          this.status = `Shell exited (${exitCode})`;
          if (this.activeTab === "terminal") this.render();
        },
        onError: (error) => {
          this.status = `Terminal error: ${error.message}`;
          if (this.activeTab === "terminal") this.render();
        },
        cwd: os.homedir(),
        rows,
      });
      this.terminalCwd = os.homedir();
      this.selectTab("terminal");
    } catch (error) {
      this.status = `Error: ${error.message}`;
    }
  }

  selectTab(tab, status = "") {
    if (tab === "terminal") this.enterTerminalMode();
    else this.enterNotesMode();
    this.activeTab = tab;
    this.status = status;
    this.saveActiveTab();
  }

  saveActiveTab() {
    try {
      writeActiveTab(this.stateDir, this.activeTab);
    } catch (error) {
      this.status = `Save failed: ${error.message}`;
    }
  }

  enterTerminalMode() {
    if (!this.started || !this.keyboardProtocolEnabled) return;
    process.stdout.write(KITTY_KEYBOARD_POP);
    this.keyboardProtocolEnabled = false;
  }

  enterNotesMode() {
    if (!this.started || this.keyboardProtocolEnabled) return;
    process.stdout.write(KITTY_KEYBOARD_PUSH);
    this.keyboardProtocolEnabled = true;
  }

  terminalSize() {
    const width = Math.max(40, process.stdout.columns || 80);
    const height = Math.max(12, process.stdout.rows || 24);
    return { cols: width, rows: Math.max(2, height - 2) };
  }

  noteViewport() {
    const height = Math.max(12, process.stdout.rows || 24);
    const footerHeight = this.status ? 2 : 1;
    const noteLimit = Math.max(1, height - 1 - footerHeight);
    const noteStart = Math.max(0, this.noteRow - noteLimit + 1);
    return {
      noteEnd: Math.min(this.noteLines.length, noteStart + noteLimit),
      noteStart,
    };
  }

  noteLocationFromMouse(event) {
    if (event.row < 1) return null;
    const { noteEnd, noteStart } = this.noteViewport();
    const row = noteStart + event.row - 1;
    if (row < noteStart || row >= noteEnd) return null;
    const line = this.noteLines[row] || "";
    const rendered = renderMarkdownLineWithCursor(line, {
      codeBlock: this.codeBlockAt(row),
      displayColumn: Math.max(0, event.column),
    });
    return { column: rendered.sourceColumn ?? line.length, row };
  }

  resizeTerminal() {
    if (!this.terminalSession) return;
    const { cols, rows } = this.terminalSize();
    this.terminalSession.resize(cols, rows);
  }

  noteOffset() {
    return this.noteLines.slice(0, this.noteRow).reduce((offset, line) => offset + line.length + 1, 0)
      + this.noteColumn;
  }

  setNoteOffset(offset) {
    const text = this.noteLines.join("\n");
    const target = Math.max(0, Math.min(text.length, offset));
    let start = 0;
    for (let row = 0; row < this.noteLines.length; row += 1) {
      const line = this.noteLines[row];
      const end = start + line.length;
      if (target <= end || row === this.noteLines.length - 1) {
        this.noteRow = row;
        this.noteColumn = target - start;
        return;
      }
      start = end + 1;
    }
    this.noteRow = this.noteLines.length - 1;
    this.noteColumn = this.noteLines[this.noteRow].length;
  }

  selectionRange() {
    if (this.selectionAnchor === null) return null;
    const current = this.noteOffset();
    if (current === this.selectionAnchor) return null;
    return {
      start: Math.min(this.selectionAnchor, current),
      end: Math.max(this.selectionAnchor, current),
    };
  }

  selectedText() {
    const range = this.selectionRange();
    if (!range) return "";
    return this.noteLines.join("\n").slice(range.start, range.end);
  }

  clearSelection() {
    this.selectionAnchor = null;
  }

  beginSelection() {
    if (this.selectionAnchor === null) this.selectionAnchor = this.noteOffset();
  }

  selectAllNote() {
    this.selectionAnchor = 0;
    this.setNoteOffset(this.noteLines.join("\n").length);
    this.status = "All notes selected";
  }

  moveNote(rowDelta, columnDelta, extend = false) {
    if (extend) this.beginSelection();
    else this.clearSelection();
    this.noteRow = Math.max(0, Math.min(this.noteLines.length - 1, this.noteRow + rowDelta));
    const lineLength = this.noteLines[this.noteRow].length;
    if (rowDelta === 0 && columnDelta < 0) {
      this.noteColumn = previousGraphemeBoundary(this.noteLines[this.noteRow], this.noteColumn);
    } else if (rowDelta === 0 && columnDelta > 0) {
      this.noteColumn = nextGraphemeBoundary(this.noteLines[this.noteRow], this.noteColumn);
    } else {
      this.noteColumn = Math.max(0, Math.min(lineLength, this.noteColumn + columnDelta));
    }
    if (rowDelta) this.noteColumn = Math.min(this.noteColumn, lineLength);
  }

  moveNoteTo(column, extend = false) {
    if (extend) this.beginSelection();
    else this.clearSelection();
    this.noteColumn = Math.max(0, Math.min(this.noteLines[this.noteRow].length, column));
  }

  removeSelection() {
    const range = this.selectionRange();
    if (!range) return false;
    const text = this.noteLines.join("\n");
    this.noteLines = `${text.slice(0, range.start)}${text.slice(range.end)}`.split("\n");
    this.setNoteOffset(range.start);
    this.clearSelection();
    return true;
  }

  replaceSelection(value) {
    const text = this.noteLines.join("\n");
    const range = this.selectionRange();
    const start = range ? range.start : this.noteOffset();
    const end = range ? range.end : start;
    const replacement = String(value);
    this.noteLines = `${text.slice(0, start)}${replacement}${text.slice(end)}`.split("\n");
    this.setNoteOffset(start + replacement.length);
    this.clearSelection();
    this.autoSaveNote();
  }

  copyNote() {
    const hasSelection = Boolean(this.selectionRange());
    const text = hasSelection ? this.selectedText() : this.noteLines[this.noteRow];
    try {
      this.clipboard.write(text);
      this.status = hasSelection ? "Copied selection" : "Copied line";
    } catch (error) {
      this.status = `Copy failed: ${error.message}`;
    }
  }

  clearAllNote() {
    this.noteLines = [""];
    this.noteRow = 0;
    this.noteColumn = 0;
    this.clearSelection();
    this.mouseSelectionActive = false;
    this.autoSaveNote();
  }

  cutNote() {
    if (!this.selectionRange()) {
      this.status = "Select text to cut";
      return;
    }
    try {
      this.clipboard.write(this.selectedText());
      this.removeSelection();
      this.autoSaveNote();
    } catch (error) {
      this.status = `Cut failed: ${error.message}`;
    }
  }

  pasteNote() {
    try {
      this.replaceSelection(this.clipboard.read());
    } catch (error) {
      this.status = `Paste failed: ${error.message}`;
    }
  }

  deleteToStart() {
    if (this.removeSelection()) return this.autoSaveNote();
    if (this.noteColumn === 0) return;
    this.noteLines[this.noteRow] = this.noteLines[this.noteRow].slice(this.noteColumn);
    this.noteColumn = 0;
    this.autoSaveNote();
  }

  deleteToEnd() {
    if (this.removeSelection()) return this.autoSaveNote();
    const line = this.noteLines[this.noteRow];
    if (this.noteColumn === line.length) return;
    this.noteLines[this.noteRow] = line.slice(0, this.noteColumn);
    this.autoSaveNote();
  }

  deleteWord() {
    if (this.removeSelection()) return this.autoSaveNote();
    const line = this.noteLines[this.noteRow];
    const prefix = line.slice(0, this.noteColumn);
    const match = prefix.match(/\s*\S+\s*$/u);
    if (!match) return;
    this.noteLines[this.noteRow] = `${prefix.slice(0, prefix.length - match[0].length)}${line.slice(this.noteColumn)}`;
    this.noteColumn -= match[0].length;
    this.autoSaveNote();
  }

  splitNoteLine() {
    if (this.selectionRange()) return this.replaceSelection("\n");
    this.clearSelection();
    const line = this.noteLines[this.noteRow];
    this.noteLines[this.noteRow] = line.slice(0, this.noteColumn);
    this.noteLines.splice(this.noteRow + 1, 0, line.slice(this.noteColumn));
    this.noteRow += 1;
    this.noteColumn = 0;
    this.autoSaveNote();
  }

  backspaceNote() {
    if (this.removeSelection()) return this.autoSaveNote();
    this.clearSelection();
    if (this.noteColumn > 0) {
      const line = this.noteLines[this.noteRow];
      const previous = previousGraphemeBoundary(line, this.noteColumn);
      this.noteLines[this.noteRow] = line.slice(0, previous) + line.slice(this.noteColumn);
      this.noteColumn = previous;
      this.autoSaveNote();
    } else if (this.noteRow > 0) {
      const previous = this.noteLines[this.noteRow - 1];
      this.noteColumn = previous.length;
      this.noteLines[this.noteRow - 1] += this.noteLines[this.noteRow];
      this.noteLines.splice(this.noteRow, 1);
      this.noteRow -= 1;
      this.autoSaveNote();
    }
  }

  deleteNoteCharacter() {
    if (this.removeSelection()) return this.autoSaveNote();
    this.clearSelection();
    const line = this.noteLines[this.noteRow];
    if (this.noteColumn < line.length) {
      const next = nextGraphemeBoundary(line, this.noteColumn);
      this.noteLines[this.noteRow] = line.slice(0, this.noteColumn) + line.slice(next);
      this.autoSaveNote();
    } else if (this.noteRow < this.noteLines.length - 1) {
      this.noteLines[this.noteRow] += this.noteLines[this.noteRow + 1];
      this.noteLines.splice(this.noteRow + 1, 1);
      this.autoSaveNote();
    }
  }

  saveNote() {
    writeNote(this.stateDir, this.noteLines.join("\n"));
  }

  autoSaveNote() {
    try {
      this.saveNote();
      this.recordHistory();
      this.status = "";
    } catch (error) {
      this.status = `Save failed: ${error.message}`;
    }
  }

  recordHistory() {
    const snapshot = { text: this.noteLines.join("\n"), offset: this.noteOffset() };
    const current = this.history[this.historyIndex];
    if (current && current.text === snapshot.text && current.offset === snapshot.offset) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(snapshot);
    this.historyIndex = this.history.length - 1;
  }

  restoreHistory(snapshot) {
    this.noteLines = snapshot.text.split("\n");
    this.setNoteOffset(snapshot.offset);
    this.clearSelection();
    try {
      this.saveNote();
      this.status = "";
    } catch (error) {
      this.status = `Save failed: ${error.message}`;
    }
  }

  undoNote() {
    if (this.historyIndex <= 0) return;
    this.historyIndex -= 1;
    this.restoreHistory(this.history[this.historyIndex]);
  }

  redoNote() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex += 1;
    this.restoreHistory(this.history[this.historyIndex]);
  }

  codeBlockAt(row) {
    let inside = false;
    for (let index = 0; index < row; index += 1) {
      if (/^\s*(```|~~~)/.test(this.noteLines[index])) inside = !inside;
    }
    return inside;
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      this.saveNote();
      this.saveActiveTab();
      await closePopup();
    } catch (error) {
      this.status = `Close failed: ${error.message}`;
    } finally {
      this.stop();
    }
  }

  stop() {
    this.started = false;
    this.terminalSession?.dispose();
    this.terminalSession = null;
    if (this.keyboardProtocolEnabled) {
      process.stdout.write(KITTY_KEYBOARD_POP);
      this.keyboardProtocolEnabled = false;
    }
    if (this.mouseProtocolEnabled) {
      process.stdout.write(MOUSE_POP);
      this.mouseProtocolEnabled = false;
    }
    process.stdin.off("data", this.onData);
    process.stdin.off("end", this.onEnd);
    process.stdout.off("resize", this.onResize);
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
    process.exit(0);
  }

  render() {
    const width = Math.max(40, process.stdout.columns || 80);
    const height = Math.max(12, process.stdout.rows || 24);
    const lines = [];
    let noteCursor = null;
    const notesTab = `${this.activeTab === "notes" ? `${BOLD}${YELLOW}` : DIM}${tabLabel("Notes", this.activeTab === "notes", NOTES_TAB.end)}${RESET}`;
    const terminalTab = `${this.activeTab === "terminal" ? `${BOLD}${YELLOW}` : DIM}${tabLabel("Terminal", this.activeTab === "terminal", TERMINAL_TAB.end - TERMINAL_TAB.start)}${RESET}`;
    lines.push(`${notesTab}  ${terminalTab}`);

    if (this.activeTab === "terminal") {
      const terminalScreen = this.terminalSession?.screen();
      const terminalRows = Math.max(1, height - lines.length - 1);
      for (let row = 0; row < terminalRows; row += 1) {
        lines.push(clip(terminalScreen?.lines[row] || "", width));
      }
      lines.push(`${DIM}Switch tab: Ctrl+T · Esc close${RESET}`);
    } else {
      const footerHeight = this.status ? 2 : 1;
      const { noteEnd, noteStart } = this.noteViewport();
      const selection = this.selectionRange();
      let sourceOffset = this.noteLines.slice(0, noteStart).reduce((offset, current) => offset + current.length + 1, 0);
      for (let index = noteStart; index < noteEnd; index += 1) {
        const line = this.noteLines[index] || "";
        const activeLine = index === this.noteRow;
        const lineSelectionStart = selection ? Math.max(0, selection.start - sourceOffset) : null;
        const lineSelectionEnd = selection ? Math.min(line.length, selection.end - sourceOffset) : null;
        const rendered = renderMarkdownLineWithCursor(line, {
          codeBlock: this.codeBlockAt(index),
          cursorColumn: activeLine ? this.noteColumn : null,
          selectionStart: lineSelectionStart < lineSelectionEnd ? lineSelectionStart : null,
          selectionEnd: lineSelectionStart < lineSelectionEnd ? lineSelectionEnd : null,
        });
        if (activeLine) {
          noteCursor = { row: lines.length + 1, column: rendered.cursorColumn };
        }
        lines.push(clip(rendered.text, width));
        sourceOffset += line.length + 1;
      }
      while (lines.length < height - footerHeight) lines.push("");
      if (this.status) lines.push(`${YELLOW}${clip(this.status, width)}${RESET}`);
      lines.push(`${DIM}Markdown · Ctrl+T terminal · Esc close${RESET}`);
    }

    while (lines.length < height) lines.push("");
    let output = "\x1b[2J\x1b[H\x1b[?25l" + lines.slice(0, height).map((line) => clip(line, width)).join("\r\n");
    if (this.activeTab === "terminal" && this.terminalSession) {
      const cursor = this.terminalSession.screen().cursor;
      output += `\x1b[${cursor.row + 2};${cursor.column + 1}H\x1b[?25h`;
    } else if (this.activeTab === "notes" && noteCursor) {
      const column = Math.max(0, Math.min(width - 1, noteCursor.column));
      output += `\x1b[${noteCursor.row};${column + 1}H\x1b[?25h`;
    }
    process.stdout.write(output);
  }
}

function startUi() {
  const ui = new WorkbenchUi();
  ui.start();
}

module.exports = { WorkbenchUi, clip, contextFromEnv, startUi };
