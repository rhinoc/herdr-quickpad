"use strict";

const fs = require("node:fs");
const path = require("node:path");

function stateFile(stateDir) {
  return path.join(stateDir, "workspaces.json");
}

function emptyState() {
  return {
    version: 2,
    global_note: "",
    global_updated_at: null,
    global_tab: "notes",
    workspaces: {},
  };
}

function loadState(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(stateDir), "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return emptyState();
    }
    return {
      version: 2,
      global_note: Object.hasOwn(parsed, "global_note")
        ? (typeof parsed.global_note === "string" ? parsed.global_note : "")
        : null,
      global_updated_at: parsed.global_updated_at || null,
      global_tab: parsed.global_tab === "terminal" ? "terminal" : "notes",
      workspaces: parsed.workspaces && typeof parsed.workspaces === "object"
        ? parsed.workspaces
        : {},
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
}

function saveState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const destination = stateFile(stateDir);
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, destination);
}

function readNote(stateDir) {
  const state = loadState(stateDir);
  if (state.global_note !== null) return state.global_note;

  // A v1 state file stored one note per workspace. Use its most recently
  // updated note as the one-time migration source for the global note.
  const legacyNotes = Object.values(state.workspaces)
    .filter((workspace) => typeof workspace?.note === "string")
    .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")));
  return legacyNotes.find((workspace) => workspace.note.length > 0)?.note || legacyNotes.at(0)?.note || "";
}

function writeNote(stateDir, note) {
  const state = loadState(stateDir);
  state.global_note = note;
  state.global_updated_at = new Date().toISOString();
  saveState(stateDir, state);
}

function readActiveTab(stateDir) {
  return loadState(stateDir).global_tab;
}

function writeActiveTab(stateDir, tab) {
  if (tab !== "notes" && tab !== "terminal") {
    throw new Error(`Unknown Quickpad tab: ${tab}`);
  }
  const state = loadState(stateDir);
  state.global_tab = tab;
  saveState(stateDir, state);
}

module.exports = {
  loadState,
  readActiveTab,
  readNote,
  saveState,
  writeActiveTab,
  writeNote,
};
