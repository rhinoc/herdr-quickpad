<div align="center">
  <br />
  <h1>Quickpad</h1>
  <p>A temporary Herdr workspace for quick notes, checklists, and shell commands.</p>
  <br />
</div>

## Screenshots

<table>
  <tr>
    <td align="center">
      <img src="./assets/readme/quickpad-notes.png" width="480" alt="Quickpad Notes tab" />
      <br />
      <sub>Notes tab with an auto-saving checklist</sub>
    </td>
    <td align="center">
      <img src="./assets/readme/quickpad-terminal.png" width="480" alt="Quickpad Terminal tab" />
      <br />
      <sub>Terminal tab inside the same popup</sub>
    </td>
  </tr>
</table>

Quickpad is a Herdr plugin for temporary work. It opens a focused popup with two full-screen tabs:

- **Notes** for short-lived Markdown or plain-text notes
- **Terminal** for shell sessions, including long-running commands, without opening a separate terminal window

## Features

- 📝 **Auto-saving Markdown notes** — Edit, split, and delete lines without a separate save action. Markdown renders inline like a lightweight Typora view, while syntax under the cursor remains temporarily visible for editing.
- 🖥️ **Embedded terminal** — Start a shell in the current popup, rooted at your home directory; its session survives closing and reopening Quickpad.
- 🔁 **Fast tab switching** — Click either tab or press `Ctrl+T` from either tab.
- 📍 **Remembers your tab** — Quickpad reopens on the Notes or Terminal tab you used last.
- 🧹 **Temporary by design** — `cmd+j` toggles the popup and `Esc` closes it.

## Requirements

- Herdr **0.9.0** or newer
- Node.js with native dependencies supported on macOS or Linux

## Install

Install the plugin from GitHub:

```bash
herdr plugin install rhinoc/herdr-quickpad
herdr plugin action list --plugin rhinoc.herdr-workbench
```

Add a global shortcut to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "cmd+j"
type = "plugin_action"
command = "rhinoc.herdr-workbench.toggle"
description = "toggle quickpad"
```

Reload the configuration:

```bash
herdr config check
herdr server reload-config
```

## Usage

Open Quickpad with `cmd+j`.

Quickpad reopens on the tab that was active when you last closed it.

### Notes

- Type normally; changes are saved automatically.
- `Enter` inserts a new line.
- Arrow keys move the cursor.
- `Delete` and `Backspace` remove text or join adjacent lines.
- `cmd+a` selects all, `cmd+c` copies, `cmd+x` cuts, and `cmd+v` pastes. With no selection, `cmd+c` copies the current line. `Ctrl+C` clears all note content.
- `cmd+z` undoes and `cmd+shift+z` or `cmd+y` redoes. `Ctrl+U`, `Ctrl+K`, and `Ctrl+W` delete to the line start, line end, and previous word.
- Hold `Shift` with the arrow, `Home`, or `End` keys to select a range.
- Drag with the left mouse button to select text; the selection can then be copied or cut.
- Type Markdown directly; headings, emphasis, lists, code, and task checkboxes such as `- [ ]` or `-[]` render inline. Syntax is revealed only while the cursor is inside the corresponding Markdown control sequence.
- `Ctrl+T` switches to Terminal.

### Terminal

- The first switch starts a shell in the user home directory.
- Switching back and forth reuses the same shell session.
- Closing and reopening Quickpad reconnects to the same shell, so long-running commands keep running.
- `Ctrl+T` switches back to Notes.
- Other control keys, including `Ctrl+U`, `Ctrl+K`, `Ctrl+C`, and `Ctrl+D`, are passed to the shell.
- Shell input stays inside this popup; Quickpad does not open a separate Herdr tab.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `cmd+j` | Open or close Quickpad |
| `Ctrl+T` in either tab | Switch between Notes and Terminal |
| `Esc` | Close Quickpad |

The `Notes` and `Terminal` labels at the top are clickable from either tab.

## Data

Notes are stored in Herdr's plugin state directory. All Herdr spaces share the same global note.

## Development

Install dependencies and run the test suite:

```bash
npm install
npm test
```

The plugin entry point is `index.js`. The `toggle` command opens or closes Quickpad; the `ui` command runs the popup interface.
