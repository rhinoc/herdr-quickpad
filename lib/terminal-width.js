"use strict";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MARK = /^\p{Mark}$/u;

function codePointWidth(codepoint) {
  if (
    codepoint === 0
    || codepoint === 0x00ad
    || (codepoint >= 0x0300 && codepoint <= 0x036f)
    || (codepoint >= 0x1ab0 && codepoint <= 0x1aff)
    || (codepoint >= 0x1dc0 && codepoint <= 0x1dff)
    || (codepoint >= 0x20d0 && codepoint <= 0x20ff)
    || (codepoint >= 0xfe00 && codepoint <= 0xfe0f)
    || (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff)
    || (codepoint >= 0x200b && codepoint <= 0x200f)
    || (codepoint >= 0x202a && codepoint <= 0x202e)
    || (codepoint >= 0x2060 && codepoint <= 0x2064)
    || (codepoint >= 0x2066 && codepoint <= 0x206f)
    || (codepoint >= 0xe0100 && codepoint <= 0xe01ef)
  ) return 0;

  if (
    codepoint === 0x2329
    || codepoint === 0x232a
    || (codepoint >= 0x1100 && codepoint <= 0x115f)
    || (codepoint >= 0x2e80 && codepoint <= 0xa4cf && codepoint !== 0x303f)
    || (codepoint >= 0xac00 && codepoint <= 0xd7a3)
    || (codepoint >= 0xf900 && codepoint <= 0xfaff)
    || (codepoint >= 0xfe10 && codepoint <= 0xfe19)
    || (codepoint >= 0xfe30 && codepoint <= 0xfe6f)
    || (codepoint >= 0xff00 && codepoint <= 0xff60)
    || (codepoint >= 0xffe0 && codepoint <= 0xffe6)
    || (codepoint >= 0x1f300 && codepoint <= 0x1faff)
    || (codepoint >= 0x20000 && codepoint <= 0x3fffd)
  ) return 2;

  return 1;
}

function graphemeWidth(value, startColumn = 0) {
  if (value === "\t") return 8 - (startColumn % 8);

  const codepoints = Array.from(value, (character) => character.codePointAt(0));
  if (codepoints.length === 0 || codepoints.every((codepoint) => codePointWidth(codepoint) === 0)) return 0;

  // A joined emoji or a regional-indicator flag occupies one terminal glyph.
  if (value.includes("\u200d") || (codepoints.length === 2 && codepoints.every((codepoint) => codepoint >= 0x1f1e6 && codepoint <= 0x1f1ff))) {
    return 2;
  }

  const base = codepoints.find((codepoint) => !MARK.test(String.fromCodePoint(codepoint)) && codePointWidth(codepoint) > 0);
  return base === undefined ? 0 : codePointWidth(base);
}

function graphemeEntries(value) {
  return Array.from(graphemeSegmenter.segment(value), ({ index, segment }) => ({ index, segment }));
}

function displayOffsets(value, startColumn = 0) {
  const offsets = Array(value.length + 1).fill(0);
  let width = 0;
  for (const { index, segment } of graphemeEntries(value)) {
    const end = index + segment.length;
    offsets[index] = width;
    for (let offset = index + 1; offset < end; offset += 1) offsets[offset] = width;
    width += graphemeWidth(segment, startColumn + width);
    offsets[end] = width;
  }
  return { offsets, width };
}

function displayWidth(value, startColumn = 0) {
  return displayOffsets(value, startColumn).width;
}

function firstGrapheme(value) {
  return graphemeEntries(value)[0]?.segment || "";
}

function previousGraphemeBoundary(value, offset) {
  const target = Math.max(0, Math.min(value.length, offset));
  let previous = 0;
  for (const { index, segment } of graphemeEntries(value)) {
    const end = index + segment.length;
    if (target <= index) return previous;
    if (target <= end) return index;
    previous = end;
  }
  return previous;
}

function nextGraphemeBoundary(value, offset) {
  const target = Math.max(0, Math.min(value.length, offset));
  for (const { index, segment } of graphemeEntries(value)) {
    const end = index + segment.length;
    if (target < end) return end;
  }
  return value.length;
}

module.exports = {
  displayOffsets,
  displayWidth,
  firstGrapheme,
  graphemeWidth,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
};
