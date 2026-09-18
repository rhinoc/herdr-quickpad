"use strict";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const STRIKETHROUGH = "\x1b[9m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const SELECTION = "\x1b[7m";
const CHECKBOX_UNCHECKED = "\u{f0131}";
const CHECKBOX_CHECKED = "\u{f0c52}";
const { displayOffsets, displayWidth } = require("./terminal-width");

function safeText(value) {
  return String(value || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function visibleLength(value, startColumn = 0) {
  return displayWidth(value, startColumn);
}

function chunk(start, end, text, style = "", sourceText = text) {
  return { start, end, text: safeText(text), sourceText: safeText(sourceText), style };
}

function appendInline(chunks, source, start, end, cursorColumn = null) {
  const value = source.slice(start, end);
  const pattern = /(\*\*|__)(.+?)\1|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|(?<!\w)(\*|_)([^*_]+?)\7/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(value))) {
    if (match.index > cursor) chunks.push(chunk(
      start + cursor,
      start + match.index,
      value.slice(cursor, match.index),
      "",
      value.slice(cursor, match.index),
    ));

    const matchStart = start + match.index;
    const matchEnd = matchStart + match[0].length;
    const editingSyntax = cursorColumn !== null && cursorColumn >= matchStart && cursorColumn < matchEnd;
    if (editingSyntax) {
      chunks.push(chunk(matchStart, matchEnd, match[0], DIM, match[0]));
    } else if (match[1]) {
      chunks.push(chunk(matchStart, matchEnd, match[2], BOLD, match[0]));
    } else if (match[3]) {
      chunks.push(chunk(matchStart, matchEnd, match[3], STRIKETHROUGH, match[0]));
    } else if (match[4]) {
      chunks.push(chunk(matchStart, matchEnd, `\`${match[4]}\``, DIM, match[0]));
    } else if (match[5]) {
      chunks.push(chunk(matchStart, matchEnd, match[5], `${CYAN}\x1b[4m`, match[0]));
    } else {
      chunks.push(chunk(matchStart, matchEnd, match[8], ITALIC, match[0]));
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < value.length) chunks.push(chunk(start + cursor, end, value.slice(cursor), "", value.slice(cursor)));
  if (value.length === 0) chunks.push(chunk(start, end, "", "", ""));
}

function appendMapped(chunks, source, start, end, text, style = "") {
  chunks.push(chunk(start, end, text, style, source.slice(start, end)));
  if (start === end && text.length === 0) return;
  if (start === end) return;
  if (end > source.length) throw new Error("Markdown chunk exceeds source line");
}

function isFence(line) {
  return /^\s*(```|~~~)/.test(line);
}

function renderChunks(
  chunks,
  sourceLength,
  cursorColumn = null,
  selectionStart = null,
  selectionEnd = null,
  displayColumn = null,
) {
  const positions = Array(sourceLength + 1).fill(0);
  const displayToSource = [];
  let visible = 0;

  for (const current of chunks) {
    const { offsets: textOffsets, width: length } = displayOffsets(current.text, visible);
    const sourceWidth = Math.max(0, current.end - current.start);
    const sourceText = current.sourceText || "";
    const sourceContentStart = sourceText.length > 0 ? sourceText.indexOf(current.text) : -1;
    const hasSourceContent = sourceContentStart >= 0 && current.text.length > 0;

    for (let offset = 0; offset <= sourceWidth && current.start + offset < positions.length; offset += 1) {
      let displayOffset;
      if (hasSourceContent && offset >= sourceContentStart && offset <= sourceContentStart + current.text.length) {
        const textOffset = offset - sourceContentStart;
        displayOffset = textOffsets[textOffset] ?? length;
      } else if (hasSourceContent && offset < sourceContentStart) {
        displayOffset = 0;
      } else if (hasSourceContent) {
        displayOffset = length;
      } else {
        displayOffset = sourceWidth === 0
          ? 0
          : offset === sourceWidth
            ? length
            : Math.floor((length * offset) / sourceWidth);
      }
      positions[current.start + offset] = visible + displayOffset;
    }

    for (let offset = 0; offset <= length; offset += 1) {
      if (hasSourceContent) {
        let sourceTextOffset = 0;
        for (let textOffset = 0; textOffset < textOffsets.length; textOffset += 1) {
          if (textOffsets[textOffset] > offset) break;
          sourceTextOffset = textOffset;
        }
        const sourceOffset = offset === length
          ? sourceWidth
          : sourceContentStart + sourceTextOffset;
        displayToSource[visible + offset] = current.start + sourceOffset;
      } else {
        displayToSource[visible + offset] = current.end;
      }
    }
    if (hasSourceContent) {
      displayToSource[visible] = current.start + sourceContentStart;
      displayToSource[visible + length] = current.end;
    }
    visible += length;
  }

  const cursorPosition = cursorColumn === null
    ? null
    : positions[Math.max(0, Math.min(sourceLength, cursorColumn))] ?? visible;
  let sourcePosition = null;
  if (displayColumn !== null) {
    const target = Math.max(0, Math.min(visible, displayColumn));
    sourcePosition = displayToSource[target] ?? sourceLength;
  }
  let output = "";
  for (const current of chunks) {
    const selected = selectionStart !== null
      && selectionEnd !== null
      && selectionEnd > selectionStart
      && current.end > selectionStart
      && current.start < selectionEnd;
    output += `${current.style}${selected ? SELECTION : ""}`;
    for (const character of Array.from(current.text)) {
      output += character;
    }
    output += RESET;
  }
  return { text: output, cursorColumn: cursorPosition, sourceColumn: sourcePosition };
}

function renderMarkdownLineWithCursor(line, {
  cursorColumn = null,
  codeBlock = false,
  raw = false,
  selectionStart = null,
  selectionEnd = null,
  displayColumn = null,
} = {}) {
  const source = safeText(line);
  const chunks = [];

  if (raw) {
    const sourceCursor = cursorColumn === null
      ? null
      : Math.max(0, Math.min(source.length, cursorColumn));
    return {
      text: source,
      cursorColumn: sourceCursor,
      sourceColumn: displayColumn === null
        ? null
        : Math.max(0, Math.min(source.length, displayColumn)),
    };
  }

  if (codeBlock) {
    appendMapped(chunks, source, 0, source.length, source, `${DIM}${GREEN}`);
    return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
  }

  const heading = source.match(/^(\s*)#{1,6}\s+(.+)$/);
  if (heading) {
    const contentStart = heading[1].length + source.slice(heading[1].length).indexOf(heading[2]);
    const revealSyntax = cursorColumn !== null && cursorColumn < contentStart;
    appendMapped(chunks, source, 0, contentStart, revealSyntax ? source.slice(0, contentStart) : heading[1], DIM);
    const contentChunkStart = chunks.length;
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    for (let index = contentChunkStart; index < chunks.length; index += 1) {
      chunks[index].style = `${BOLD}${YELLOW}${chunks[index].style}`;
    }
    return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
  }

  const checklist = source.match(/^(\s*)([-+*])\s*\[\s*([xX]?)\s*\]\s*(.*)$/);
  if (checklist) {
    const contentStart = source.length - checklist[4].length;
    const checked = checklist[3].toLowerCase() === "x";
    const revealSyntax = cursorColumn !== null && cursorColumn < contentStart;
    appendMapped(
      chunks,
      source,
      0,
      contentStart,
      revealSyntax ? source.slice(0, contentStart) : `${checklist[1]}${checked ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED} `,
      revealSyntax ? DIM : `${BOLD}${checked ? GREEN : YELLOW}`,
    );
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
  }

  const unordered = source.match(/^(\s*)[-+*]\s+(.+)$/);
  if (unordered) {
    const contentStart = source.length - unordered[2].length;
    const revealSyntax = cursorColumn !== null && cursorColumn < contentStart;
    appendMapped(chunks, source, 0, contentStart, revealSyntax ? source.slice(0, contentStart) : `${unordered[1]}• `, revealSyntax ? DIM : "");
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
  }

  const ordered = source.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (ordered) {
    const contentStart = source.length - ordered[3].length;
    const revealSyntax = cursorColumn !== null && cursorColumn < contentStart;
    appendMapped(chunks, source, 0, contentStart, revealSyntax ? source.slice(0, contentStart) : `${ordered[1]}${ordered[2]}. `, revealSyntax ? DIM : "");
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
  }

  const quote = source.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    const contentStart = source.length - quote[2].length;
    const revealSyntax = cursorColumn !== null && cursorColumn < contentStart;
    appendMapped(chunks, source, 0, contentStart, revealSyntax ? source.slice(0, contentStart) : `${quote[1]}│ `, DIM);
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
  }

  if (/^\s*((\*|-|_)\s*){3,}$/.test(source)) {
    appendMapped(chunks, source, 0, source.length, "────────────────");
    return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
  }

  if (isFence(source)) {
    appendMapped(chunks, source, 0, source.length, source, DIM);
    return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
  }

  appendInline(chunks, source, 0, source.length, cursorColumn);
  return renderChunks(chunks, source.length, cursorColumn, selectionStart, selectionEnd, displayColumn);
}

function renderMarkdownLine(line, options = {}) {
  return renderMarkdownLineWithCursor(line, options).text;
}

function renderNoteLines(lines, { codeBlocks = [] } = {}) {
  return lines.map((line, index) => renderMarkdownLine(line, { codeBlock: Boolean(codeBlocks[index]) }));
}

module.exports = {
  renderMarkdownLine,
  renderMarkdownLineWithCursor,
  renderNoteLines,
  safeText,
  visibleLength,
};
