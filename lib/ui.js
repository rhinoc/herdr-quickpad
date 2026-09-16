"use strict";

const os = require("node:os");
const { closePopup } = require("./api");
const { InputDecoder, csiEvent } = require("./input");
const { readNote, writeNote } = require("./state");
const { createTerminalSession } = require("./terminal");

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const KITTY_KEYBOARD_PUSH = "\x1b[>31u";
const KITTY_KEYBOARD_POP = "\x1b[<1u";
const MOUSE_PUSH = "\x1b[?1000h\x1b[?1006h";
const MOUSE_POP = "\x1b[?1006l\x1b[?1000l";
const NOTES_TAB = { start: 0, end: 9 };
const TERMINAL_TAB = { start: 11, end: 23 };

function clip(value, width) {
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function contextFromEnv() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function insertAt(text, index, value) {
  return text.slice(0, index) + value + text.slice(index);
}

function tabLabel(label, active, width) {
  const text = active ? `[ ${label} ]` : `  ${label}  `;
  return text.padEnd(width, " ");
}

class WorkbenchUi {
  constructor({ terminalFactory = createTerminalSession } = {}) {
    this.context = contextFromEnv();
    this.stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    if (!this.stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set");
    this.noteLines = readNote(this.stateDir).split("\n");
    this.activeTab = "notes";
    this.noteRow = this.noteLines.length - 1;
    this.noteColumn = this.noteLines[this.noteRow].length;
    this.terminalFactory = terminalFactory;
    this.terminalSession = null;
    this.terminalCwd = null;
    this.status = "";
    this.decoder = new InputDecoder();
    this.closing = false;
    this.started = false;
    this.keyboardProtocolEnabled = false;
    this.mouseProtocolEnabled = false;
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
    this.render();
  }

  handleInput(chunk) {
    if (this.activeTab === "terminal") return this.handleTerminalInput(chunk.toString("utf8"));
    return this.handle(this.decoder.feed(chunk));
  }

  handleTerminalInput(chunk) {
    const event = csiEvent(chunk);
    if (event.type === "mouse") return this.handleMouse(event);
    if (event.type === "escape" || chunk === "\x1b") return this.close();

    const interruptIndex = chunk.indexOf("\x0e");
    if (interruptIndex >= 0) {
      if (interruptIndex > 0) this.terminalSession?.write(chunk.slice(0, interruptIndex));
      return this.selectTab("notes");
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
    if (event.action !== "press" || event.button !== 0 || event.row !== 0) return;
    if (event.column >= NOTES_TAB.start && event.column < NOTES_TAB.end) {
      return this.selectTab("notes");
    }
    if (event.column >= TERMINAL_TAB.start && event.column < TERMINAL_TAB.end) {
      return this.openTerminalTab();
    }
  }

  handleNotes(event) {
    if (event.type === "terminal" || event.type === "tab") return this.openTerminalTab();
    if (event.type === "notes") return;
    if (event.type === "interrupt") {
      return this.close();
    }
    if (event.type === "up") return this.moveNote(-1, 0);
    if (event.type === "down") return this.moveNote(1, 0);
    if (event.type === "left") return this.moveNote(0, -1);
    if (event.type === "right") return this.moveNote(0, 1);
    if (event.type === "home") return this.noteColumn = 0;
    if (event.type === "end") return this.noteColumn = this.noteLines[this.noteRow].length;
    if (event.type === "enter") return this.splitNoteLine();
    if (event.type === "backspace") return this.backspaceNote();
    if (event.type === "delete") return this.deleteNoteCharacter();
    if (event.type === "text") {
      const line = this.noteLines[this.noteRow];
      this.noteLines[this.noteRow] = insertAt(line, this.noteColumn, event.value);
      this.noteColumn += event.value.length;
      return this.autoSaveNote();
    }
  }

  handleTerminal(event) {
    if (event.type === "notes") return this.selectTab("notes");
    if (event.type === "escape") return this.close();
    if (event.type === "terminal") return this.openTerminalTab();
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

  resizeTerminal() {
    if (!this.terminalSession) return;
    const { cols, rows } = this.terminalSize();
    this.terminalSession.resize(cols, rows);
  }

  moveNote(rowDelta, columnDelta) {
    this.noteRow = Math.max(0, Math.min(this.noteLines.length - 1, this.noteRow + rowDelta));
    const lineLength = this.noteLines[this.noteRow].length;
    this.noteColumn = Math.max(0, Math.min(lineLength, this.noteColumn + columnDelta));
    if (rowDelta) this.noteColumn = Math.min(this.noteColumn, lineLength);
  }

  splitNoteLine() {
    const line = this.noteLines[this.noteRow];
    this.noteLines[this.noteRow] = line.slice(0, this.noteColumn);
    this.noteLines.splice(this.noteRow + 1, 0, line.slice(this.noteColumn));
    this.noteRow += 1;
    this.noteColumn = 0;
    this.autoSaveNote();
  }

  backspaceNote() {
    if (this.noteColumn > 0) {
      const line = this.noteLines[this.noteRow];
      this.noteLines[this.noteRow] = line.slice(0, this.noteColumn - 1) + line.slice(this.noteColumn);
      this.noteColumn -= 1;
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
    const line = this.noteLines[this.noteRow];
    if (this.noteColumn < line.length) {
      this.noteLines[this.noteRow] = line.slice(0, this.noteColumn) + line.slice(this.noteColumn + 1);
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
      this.status = "";
    } catch (error) {
      this.status = `Save failed: ${error.message}`;
    }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      this.saveNote();
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
    const notesTab = `${this.activeTab === "notes" ? `${BOLD}${YELLOW}` : DIM}${tabLabel("Notes", this.activeTab === "notes", NOTES_TAB.end)}${RESET}`;
    const terminalTab = `${this.activeTab === "terminal" ? `${BOLD}${YELLOW}` : DIM}${tabLabel("Terminal", this.activeTab === "terminal", TERMINAL_TAB.end - TERMINAL_TAB.start)}${RESET}`;
    lines.push(`${notesTab}  ${terminalTab}`);

    if (this.activeTab === "terminal") {
      const terminalScreen = this.terminalSession?.screen();
      const terminalRows = Math.max(1, height - lines.length - 1);
      for (let row = 0; row < terminalRows; row += 1) {
        lines.push(clip(terminalScreen?.lines[row] || "", width));
      }
      lines.push(`${DIM}Notes: Ctrl+N · Esc close${RESET}`);
    } else {
      const footerHeight = this.status ? 2 : 1;
      const noteLimit = Math.max(1, height - lines.length - footerHeight);
      const noteStart = Math.max(0, this.noteRow - noteLimit + 1);
      const noteEnd = Math.min(this.noteLines.length, noteStart + noteLimit);
      for (let index = noteStart; index < noteEnd; index += 1) {
        let line = this.noteLines[index] || "";
        if (index === this.noteRow) {
          line = `${line.slice(0, this.noteColumn)}▌${line.slice(this.noteColumn)}`;
        }
        lines.push(clip(line, width));
      }
      while (lines.length < height - footerHeight) lines.push("");
      if (this.status) lines.push(`${YELLOW}${clip(this.status, width)}${RESET}`);
      lines.push(`${DIM}Terminal: Ctrl+T / Tab · Esc close${RESET}`);
    }

    while (lines.length < height) lines.push("");
    let output = "\x1b[2J\x1b[H\x1b[?25l" + lines.slice(0, height).map((line) => clip(line, width)).join("\r\n");
    if (this.activeTab === "terminal" && this.terminalSession) {
      const cursor = this.terminalSession.screen().cursor;
      output += `\x1b[${cursor.row + 2};${cursor.column + 1}H\x1b[?25h`;
    }
    process.stdout.write(output);
  }
}

function startUi() {
  const ui = new WorkbenchUi();
  ui.start();
}

module.exports = { WorkbenchUi, clip, contextFromEnv, startUi };
