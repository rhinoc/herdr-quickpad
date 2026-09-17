"use strict";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const STRIKETHROUGH = "\x1b[9m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";

function safeText(value) {
  return String(value || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function visibleLength(value) {
  return Array.from(value).length;
}

function chunk(start, end, text, style = "") {
  return { start, end, text: safeText(text), style };
}

function appendInline(chunks, source, start, end, cursorColumn = null) {
  const value = source.slice(start, end);
  const pattern = /(\*\*|__)(.+?)\1|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|(?<!\w)(\*|_)([^*_]+?)\7/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(value))) {
    if (match.index > cursor) chunks.push(chunk(start + cursor, start + match.index, value.slice(cursor, match.index)));

    const matchStart = start + match.index;
    const matchEnd = matchStart + match[0].length;
    const editingSyntax = cursorColumn !== null && cursorColumn >= matchStart && cursorColumn <= matchEnd;
    if (editingSyntax) {
      chunks.push(chunk(matchStart, matchEnd, match[0], DIM));
    } else if (match[1]) {
      chunks.push(chunk(matchStart, matchEnd, match[2], BOLD));
    } else if (match[3]) {
      chunks.push(chunk(matchStart, matchEnd, match[3], STRIKETHROUGH));
    } else if (match[4]) {
      chunks.push(chunk(matchStart, matchEnd, `\`${match[4]}\``, DIM));
    } else if (match[5]) {
      chunks.push(chunk(matchStart, matchEnd, match[5], `${CYAN}\x1b[4m`));
    } else {
      chunks.push(chunk(matchStart, matchEnd, match[8], ITALIC));
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < value.length) chunks.push(chunk(start + cursor, end, value.slice(cursor)));
  if (value.length === 0) chunks.push(chunk(start, end, ""));
}

function appendMapped(chunks, source, start, end, text, style = "") {
  chunks.push(chunk(start, end, text, style));
  if (start === end && text.length === 0) return;
  if (start === end) return;
  if (end > source.length) throw new Error("Markdown chunk exceeds source line");
}

function isFence(line) {
  return /^\s*(```|~~~)/.test(line);
}

function renderChunks(chunks, sourceLength, cursorColumn = null) {
  const positions = Array(sourceLength + 1).fill(0);
  let visible = 0;

  for (const current of chunks) {
    const length = visibleLength(current.text);
    for (let position = current.start; position <= current.end && position < positions.length; position += 1) {
      if (position === current.start) positions[position] = visible;
      else if (position === current.end) positions[position] = visible + length;
      else positions[position] = visible;
    }
    visible += length;
  }

  const cursorPosition = cursorColumn === null
    ? null
    : positions[Math.max(0, Math.min(sourceLength, cursorColumn))] ?? visible;
  let output = "";
  let position = 0;
  for (const current of chunks) {
    output += current.style;
    for (const character of Array.from(current.text)) {
      if (position === cursorPosition) output += `${YELLOW}▌${RESET}`;
      output += character;
      position += 1;
    }
    output += RESET;
  }
  if (position === cursorPosition) output += `${YELLOW}▌${RESET}`;
  return output;
}

function renderMarkdownLine(line, { cursorColumn = null, codeBlock = false } = {}) {
  const source = safeText(line);
  const chunks = [];

  if (codeBlock) {
    appendMapped(chunks, source, 0, source.length, source, `${DIM}${GREEN}`);
    return renderChunks(chunks, source.length, cursorColumn);
  }

  const heading = source.match(/^(\s*)#{1,6}\s+(.+)$/);
  if (heading) {
    const contentStart = heading[1].length + source.slice(heading[1].length).indexOf(heading[2]);
    const revealSyntax = cursorColumn !== null && cursorColumn <= contentStart;
    appendMapped(chunks, source, 0, contentStart, revealSyntax ? source.slice(0, contentStart) : heading[1], DIM);
    const contentChunkStart = chunks.length;
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    for (let index = contentChunkStart; index < chunks.length; index += 1) {
      chunks[index].style = `${BOLD}${YELLOW}${chunks[index].style}`;
    }
    return renderChunks(chunks, source.length, cursorColumn);
  }

  const checklist = source.match(/^(\s*)([-+*])\s+\[([ xX])\]\s+(.*)$/);
  if (checklist) {
    const contentStart = source.length - checklist[4].length;
    const checked = checklist[3].toLowerCase() === "x";
    const revealSyntax = cursorColumn !== null && cursorColumn <= contentStart;
    appendMapped(
      chunks,
      source,
      0,
      contentStart,
      revealSyntax ? source.slice(0, contentStart) : `${checklist[1]}${checked ? "☑" : "☐"} `,
      revealSyntax ? DIM : checked ? GREEN : YELLOW,
    );
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    return renderChunks(chunks, source.length, cursorColumn);
  }

  const unordered = source.match(/^(\s*)[-+*]\s+(.+)$/);
  if (unordered) {
    const contentStart = source.length - unordered[2].length;
    appendMapped(chunks, source, 0, contentStart, `${unordered[1]}• `);
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    return renderChunks(chunks, source.length, cursorColumn);
  }

  const ordered = source.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (ordered) {
    const contentStart = source.length - ordered[3].length;
    appendMapped(chunks, source, 0, contentStart, `${ordered[1]}${ordered[2]}. `);
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    return renderChunks(chunks, source.length, cursorColumn);
  }

  const quote = source.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    const contentStart = source.length - quote[2].length;
    appendMapped(chunks, source, 0, contentStart, `${quote[1]}│ `, DIM);
    appendInline(chunks, source, contentStart, source.length, cursorColumn);
    return renderChunks(chunks, source.length, cursorColumn);
  }

  if (/^\s*((\*|-|_)\s*){3,}$/.test(source)) {
    appendMapped(chunks, source, 0, source.length, "────────────────");
    return renderChunks(chunks, source.length, cursorColumn);
  }

  if (isFence(source)) {
    appendMapped(chunks, source, 0, source.length, source, DIM);
    return renderChunks(chunks, source.length, cursorColumn);
  }

  appendInline(chunks, source, 0, source.length, cursorColumn);
  return renderChunks(chunks, source.length, cursorColumn);
}

function renderNoteLines(lines, { codeBlocks = [] } = {}) {
  return lines.map((line, index) => renderMarkdownLine(line, { codeBlock: Boolean(codeBlocks[index]) }));
}

module.exports = {
  renderMarkdownLine,
  renderNoteLines,
  safeText,
  visibleLength,
};
