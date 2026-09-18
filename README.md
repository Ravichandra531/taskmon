# taskmon

> A terminal process monitor & killer — htop-lite built with raw Node.js.
> Zero npm dependencies. Raw-mode keyboard UI. ANSI rendering. Built-in modules only.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Features](#2-features)
3. [Requirements](#3-requirements)
4. [Installation](#4-installation)
5. [Usage](#5-usage)
6. [Keyboard Controls](#6-keyboard-controls)
7. [How It Works](#7-how-it-works)
8. [Project Structure](#8-project-structure)
9. [Testing](#9-testing)
10. [Limitations](#10-limitations)
11. [Roadmap](#11-roadmap)
12. [License & Disclaimer](#12-license--disclaimer)

---

## 1. Overview

`taskmon` is an interactive terminal application that displays live system
and per-process resource usage (CPU, memory) and lets you terminate processes
directly from the keyboard — no mouse, no GUI, no dependencies.

It is written entirely in **vanilla Node.js** (built-in `fs`, `os`,
`child_process` modules only). There is **no `npm install`** step. The entire
UI is rendered with raw ANSI escape codes and the keyboard is read in raw
mode — the same technique used by classic TUIs like `top`, `htop`, and `vim`.

**Why build this?** Most developers run `ps aux | grep …` then `kill -9 <pid>`
in separate steps. `taskmon` collapses that loop into a single live dashboard:
find the runaway process visually, confirm, kill — three keystrokes.

---

## 2. Features

| Feature | Description |
| --- | --- |
| **Live process table** | All processes refreshed every second: PID, CPU%, RSS memory, name, full command |
| **Real per-process CPU%** | Computed from `/proc/<pid>/stat` jiffies deltas — the same method `top` uses, not lifetime averages |
| **System CPU & memory bars** | Live `█░░░` bar gauges with color-coded thresholds (green/yellow/red) |
| **Kill from keyboard** | `k` = SIGTERM (polite), `K` = SIGKILL (force), with `y/n` confirmation |
| **4 sort modes** | CPU, memory, PID, name — cycle with `s` |
| **Live filter** | `/` then type to filter by command name or PID, `Esc` clears |
| **Cross-platform** | Native `/proc` sampler on Linux; automatic `ps` fallback on macOS/BSD |
| **Scriptable snapshot mode** | `taskmon --once` prints a plain-text top-25 snapshot and exits (pipeable, cron-friendly) |
| **Self-exclusion** | Hides its own PID so you cannot accidentally kill the monitor |
| **Safe terminal handling** | Hides cursor during UI, fully restores terminal state on exit (Ctrl-C or `q`) |
| **PID-reuse guard** | CPU deltas are validated against process start-time so reused PIDs never produce false readings |

**Zero dependencies.** No `node_modules`. No build step. Clone and run.

---

## 3. Requirements

- **Node.js ≥ 18.0.0**
- A **Unix-like OS**:
- **Linux** — full features (native `/proc` sampler)
- **macOS / BSD** — supported via the `ps` fallback sampler (per-process CPU is a lifetime average on this path — see [Limitations](#10-limitations))
- A TTY-capable terminal (any real terminal: xterm, GNOME Terminal, iTerm2, VS Code integrated terminal, SSH sessions, …)

---

## 4. Installation

```bash
# 1. get the code
git clone <repo-url> && cd taskmon

# 2. make executable (optional)
chmod +x bin/taskmon.js

# 3a. run directly
node bin/taskmon.js

# 3b. OR install globally so `taskmon` is on your PATH
npm link
taskmon
```

That's it. There is nothing to compile and nothing to install.

---

## 5. Usage

### Interactive dashboard (default)

```bash
taskmon
```

Opens the live dashboard:

```javascript
taskmon  procs: 231  sort: cpu  up: 3d 7h
CPU  ████████░░░░░░░░░░░░░░  34%   MEM  ████████████░░░░░░░░  61%  4.9G / 7.8G
────────────────────────────────────────────────────────────────────────────────
PID     CPU%   MEM     NAME             COMMAND
 9102   88.0   412M    python           python train.py --epochs 100
>8231   12.0   230M    node             node server.js
 1102    4.3   1.2G    chrome           chrome --render ...
────────────────────────────────────────────────────────────────────────────────
[↑/↓] select  [k]ill  [K]ILL  [s]ort  [/] filter  [q] quit
```

The selected row (marked `>`) is highlighted with reverse video.

### One-shot snapshot mode

```bash
taskmon --once
```

Prints a plain-text top-25 table and exits. Useful in scripts:

```bash
# find runaway node processes from a script
taskmon --once | grep node

# cron: alert if anything exceeds 90% CPU
taskmon --once | awk '$2 > 90 {print}' | mail -s "high cpu" admin@example.com
```

---

## 6. Keyboard Controls

All input is read in raw mode — key presses are handled as single bytes,
no Enter required.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection cursor up / down through the process list |
| `k` | Kill selected process with **SIGTERM** (asks for `y/n` confirmation) |
| `K` | Kill selected process with **SIGKILL** — force, uncatchable (asks `y/n`) |
| `s` | Cycle sort order: `cpu` → `mem` → `pid` → `name` → `cpu` |
| `/` | Enter **filter mode** — type to filter live by command name or PID |
| `Enter` | (in filter mode) apply filter and exit filter mode |
| `Esc` | (in filter mode) clear the filter and exit filter mode |
| `Backspace` | (in filter mode) delete last filter character |
| `y` / `n` | (at kill confirmation) confirm / cancel |
| `q` | Quit, restore terminal |
| `Ctrl-C` | Quit, restore terminal |

> **Note:** while filter mode is active, all printable characters (including
> `q`, `k`, `s`) are typed into the filter instead of triggering commands.

---

## 7. How It Works

### 7.1 Rendering — ANSI escape codes, no libraries

The entire screen is drawn by writing ANSI escape sequences directly to
stdout — the same technique as the classic terminal apps:

| Sequence | Effect | Used for |
| --- | --- | --- |
| `\x1B[2J` | Clear entire screen | startup |
| `\x1B[H` | Move cursor to home (top-left) | every re-render: redraw in place |
| `\x1B[?25l` / `\x1B[?25h` | Hide / show cursor | during UI / on exit |
| `\x1B[7m` | Reverse video | highlighting the selected process row |
| `\x1B[31m` / `32` / `33` / `36` / `90` | Colors | red/yellow/green/cyan/gray |
| `\x1B[0m` | Reset all attributes | end of every styled segment |

Every refresh tick (1 s) the full frame is rebuilt and written after `\x1B[H`,
so the display updates in place with no flicker and no scrolling.

### 7.2 Keyboard — raw mode byte parsing

`process.stdin.setRawMode(true)` disables line buffering and echo, so every
keypress arrives as raw bytes on the `data` event. Keys are matched by byte
value — exactly how classic TUIs do it:

| Input | Bytes | Meaning |
| --- | --- | --- |
| `↑` | `1B 5B 41` | cursor up |
| `↓` | `1B 5B 42` | cursor down |
| `Ctrl-C` | `03` | quit (raw mode never raises SIGINT itself) |
| `q` | `71` | quit |
| `k` / `K` | `6B` / `4B` | SIGTERM / SIGKILL request |
| `Enter` | `0D` | confirm filter |
| `Esc` | `1B` (single byte) | clear filter / cancel |
| `Backspace` | `7F` | delete filter character |

Arrow keys are distinguished from a lone `Esc` by length: arrow keys arrive
as 3-byte sequences, a standalone `Esc` arrives as 1 byte.

### 7.3 Linux sampling — `/proc` filesystem

On Linux, everything is read directly from the virtual `/proc` filesystem —
no subprocesses, no parsing external commands:

| File | What taskmon reads |
| --- | --- |
| `/proc/stat` | first line: total CPU jiffies across all cores (for system CPU% and the delta denominator) |
| `/proc/<pid>/stat` | `utime` (field 14) + `stime` (field 15): CPU time the process has consumed, in ticks; `starttime` (field 22): PID-reuse guard |
| `/proc/<pid>/statm` | resident set size (field 2, pages × 4096): actual RAM used |
| `/proc/<pid>/cmdline` | full command line (null-separated → spaces) |
| `/proc/meminfo` | `MemTotal` / `MemAvailable` for the system memory bar |

**Per-process CPU% — the delta method.** The kernel only stores *cumulative*
CPU time per process. A live percentage requires two samples:

```javascript
cpu% = 100 × (Δprocess_ticks) × cores / Δtotal_ticks
```

where `Δprocess_ticks` is the process's consumed ticks between samples and
`Δtotal_ticks` is the total ticks across all cores (from `/proc/stat`).
`cores` is included so one fully busy core reads ~100% (htop convention),
not `100/cores`.

**PID-reuse guard.** If a process dies and the kernel reassigns its PID, the
new process's cumulative ticks are unrelated to the old one's. `taskmon`
records `starttime` per PID and discards deltas when it changes — so a
reused PID never shows a garbage CPU reading.

### 7.4 Fallback sampling — `ps` (macOS / BSD)

On non-Linux systems, `taskmon` shells out to `ps -Ao pid,pcpu,pmem,comm`
via `child_process.execFile`. Memory is reconstructed from `pmem` (percent
of physical RAM), and system CPU falls back to a load-average estimate.
This path exists for portability; the Linux `/proc` path is the primary,
more accurate one.

### 7.5 Killing — signals with confirmation

`process.kill(pid, signal)` sends a POSIX signal:

- **SIGTERM (`k`)** — polite shutdown request; the process can catch it and
clean up. Always try this first.
- **SIGKILL (`K`)** — uncatchable, immediate termination. Use when SIGTERM
is ignored. The process gets no chance to save state.

A `y/n` confirmation with the exact PID, name, and signal is shown before
anything is sent. Deaths between listing and killing (ESRCH) are caught and
reported via a flash message, not a crash.

---

## 8. Project Structure

```javascript
taskmon/
├── package.json          # bin entry, node version requirement
├── bin/
│   └── taskmon.js        # entire application (single file, ~330 lines)
└── README.md             # this file
```

The app is deliberately a **single file**. Internally it is organized into
clear sections:

| Section | Responsibility |
| --- | --- |
| ANSI constants | escape-sequence definitions |
| helpers | `bar`, `fmtBytes`, `fmtUptime`, `trunc`, `pad` |
| `/proc` sampler | `readCpuTotal`, `readMemInfo`, `linuxSample` |
| `ps` fallback | `psSample` |
| state | process list, cursor, sort mode, filter, confirm/flash |
| `tick()` | one sampling pass (platform-dispatched) |
| `visibleProcs()` | filter + sort |
| `render()` | build & draw one frame |
| `doKill()` / key handlers | actions and raw-mode input parsing |
| `--once` | scriptable snapshot |
| `main` | entry point & dispatch |

---

## 9. Testing

### Manual smoke test

```bash
# 1. snapshot mode lists processes
node bin/taskmon.js --once

# 2. interactive UI starts and quits cleanly
taskmon        # then press q

# 3. kill flow
#    start a background sleeper, find it with /, select, press k, y
sleep 1000 &
taskmon
```

### 

