"use strict";

const { StringDecoder } = require("node:string_decoder");

function parseCodepoint(value) {
  if (!/^\d+$/.test(value)) return null;
  const codepoint = Number(value);
  return Number.isInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff
    ? codepoint
    : null;
}

function csiEvent(sequence) {
  const mouse = sequence.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouse) {
    return {
      type: "mouse",
      action: mouse[4] === "M" ? "press" : "release",
      button: Number(mouse[1]),
      column: Number(mouse[2]) - 1,
      row: Number(mouse[3]) - 1,
    };
  }

  const csiU = sequence.match(/^\x1b\[(.+)u$/);
  if (csiU) {
    const fields = csiU[1].split(";");
    if (fields.length > 3) return { type: "unknown" };

    const keyFields = fields[0].split(":");
    const modifierFields = (fields[1] || "1").split(":");
    if (keyFields.length > 2 || modifierFields.length > 2) return { type: "unknown" };

    const codepoint = parseCodepoint(keyFields[0]);
    const alternateCodepoint = keyFields[1] ? parseCodepoint(keyFields[1]) : null;
    const modifierValue = Number(modifierFields[0]);
    const modifiers = modifierValue - 1;
    const event = modifierFields[1] ? Number(modifierFields[1]) : 1;
    let associatedText = null;
    if (fields[2]) {
      const associatedCodepoints = fields[2].split(":").map(parseCodepoint);
      if (associatedCodepoints.some((value) => value === null)) return { type: "unknown" };
      associatedText = associatedCodepoints.map((value) => String.fromCodePoint(value)).join("");
    }

    if (codepoint === null || (keyFields[1] && alternateCodepoint === null)) {
      return { type: "unknown" };
    }
    if (!Number.isInteger(modifierValue) || modifierValue < 1 || !Number.isInteger(modifiers)) {
      return { type: "unknown" };
    }
    if (![1, 2, 3].includes(event)) return { type: "unknown" };

    // REPORT_ALL_KEYS also sends release events. Only a press/repeat should
    // reach the editor, otherwise one key press can trigger an action twice.
    if (event === 3) return { type: "unknown" };
    if (codepoint === 106 && (modifiers & 8) !== 0) return { type: "toggle" };

    if (codepoint === 27) return { type: "escape" };
    if (codepoint === 13) return { type: "enter" };
    if (codepoint === 9) return { type: "tab" };
    if (codepoint === 8 || codepoint === 127) return { type: "backspace" };
    if (codepoint === 57417) return { type: "left" };
    if (codepoint === 57418) return { type: "right" };
    if (codepoint === 57419) return { type: "up" };
    if (codepoint === 57420) return { type: "down" };
    if (codepoint === 57423) return { type: "home" };
    if (codepoint === 57424) return { type: "end" };
    if (codepoint === 57426) return { type: "delete" };

    // Preserve the existing control-key shortcuts while Kitty mode is active.
    if ((modifiers & 4) !== 0) {
      if (codepoint === 97) return { type: "home" };
      if (codepoint === 101) return { type: "end" };
      if (codepoint === 116) return { type: "switch-tab" };
      if (codepoint === 99) return { type: "interrupt" };
      return { type: "unknown" };
    }

    // Plain and Shift-modified text is also represented by CSI-u when all
    // physical keys are reported. Associated text preserves the active layout.
    const onlyTextModifiers = modifiers & ~1;
    const textCodepoint = (modifiers & 1) !== 0
      ? alternateCodepoint || codepoint
      : codepoint;
    const text = associatedText || String.fromCodePoint(textCodepoint);
    if (onlyTextModifiers === 0 && text.length > 0 && textCodepoint >= 32) {
      return { type: "text", value: text };
    }
    return { type: "unknown" };
  }

  // Some terminal modes use xterm's modifyOtherKeys form instead of Kitty
  // CSI-u. Herdr uses the same key codepoint for Backspace in both modes.
  const modifyOtherKeys = sequence.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (modifyOtherKeys) {
    const codepoint = Number(modifyOtherKeys[2]);
    if (codepoint === 27) return { type: "escape" };
    if (codepoint === 8 || codepoint === 127) return { type: "backspace" };
  }

  // Kitty's progressive keyboard modes keep the legacy CSI final character
  // but add modifier and event fields, for example CSI 3;1:1~ for Delete.
  // Treat press/repeat as the same logical key and ignore release events.
  const enhancedCsi = sequence.match(/^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?([A-Za-z~])$/);
  if (enhancedCsi) {
    const number = Number(enhancedCsi[1]);
    const event = enhancedCsi[3] ? Number(enhancedCsi[3]) : 1;
    const final = enhancedCsi[4];
    if (event === 3) return { type: "unknown" };

    if (final === "~") {
      if (number === 127) return { type: "backspace" };
      if (number === 3) return { type: "delete" };
      if (number === 5) return { type: "pageup" };
      if (number === 6) return { type: "pagedown" };
      if (number === 7) return { type: "home" };
      if (number === 8) return { type: "end" };
    } else if (number === 1 || number === 0) {
      if (final === "A") return { type: "up" };
      if (final === "B") return { type: "down" };
      if (final === "C") return { type: "right" };
      if (final === "D") return { type: "left" };
      if (final === "H") return { type: "home" };
      if (final === "F") return { type: "end" };
    }
  }

  const simple = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1b[3~": "delete",
  };
  return simple[sequence] ? { type: simple[sequence] } : { type: "unknown" };
}

class InputDecoder {
  constructor() {
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
  }

  feed(chunk) {
    this.buffer += this.decoder.write(chunk);
    return this.readEvents();
  }

  readEvents() {
    const events = [];
    while (this.buffer) {
      if (this.buffer[0] === "\x1b") {
        if (this.buffer.startsWith("\x1b[")) {
          const csiEnd = this.buffer.search(/[A-Za-z~]/);
          if (csiEnd < 0) break;
          const sequence = this.buffer.slice(0, csiEnd + 1);
          events.push(csiEvent(sequence));
          this.buffer = this.buffer.slice(csiEnd + 1);
        } else {
          events.push({ type: "escape" });
          this.buffer = this.buffer.slice(1);
        }
        continue;
      }

      const code = this.buffer.charCodeAt(0);
      if (code === 13 || code === 10) events.push({ type: "enter" });
      else if (code === 9) events.push({ type: "tab" });
      else if (code === 8 || code === 127) events.push({ type: "backspace" });
      else if (code === 20) events.push({ type: "switch-tab" });
      else if (code === 3) events.push({ type: "interrupt" });
      else if (code === 1) events.push({ type: "home" });
      else if (code === 5) events.push({ type: "end" });
      else if (code >= 32) {
        const character = Array.from(this.buffer)[0];
        events.push({ type: "text", value: character });
        this.buffer = this.buffer.slice(character.length);
        continue;
      }
      this.buffer = this.buffer.slice(1);
    }
    return events;
  }

  end() {
    this.buffer += this.decoder.end();
    return this.readEvents();
  }
}

module.exports = { InputDecoder, csiEvent };
