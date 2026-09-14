#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const os   = require('os');
const { execFile } = require('child_process');

// ANSI (structural only, no colours)
const HOME      = '\x1B[H';
const CLR_SCR   = '\x1B[2J';
const HIDE_CUR  = '\x1B[?25l';
const SHOW_CUR  = '\x1B[?25h';
const BOLD      = '\x1B[1m';
const DIM       = '\x1B[2m';
const REVERSE   = '\x1B[7m';
const RESET     = '\x1B[0m';

const TICK_MS  = 1000;
const MAX_ROWS = 10;           // visible process rows inside the box
const IS_LINUX = fs.existsSync('/proc/stat');
const CORES    = os.cpus().length;
const SELF_PID = process.pid;
const CLK_TCK  = 100;          // USER_HZ on Linux
const IW       = 40;           // inner width between box sides

// Strip ANSI codes to measure visible length
function stripAnsi(s) { return s.replace(/\x1B\[[0-9;]*m/g, ''); }

function bar(pct, width) {
    const p = Math.max(0, Math.min(100, pct));
    const filled = Math.round((width * p) / 100);
    return '▓'.repeat(filled) + '░'.repeat(width - filled);
}
function fmtBytes(b) {
    if (b > 1073741824) return (b / 1073741824).toFixed(1) + 'G';
    if (b > 1048576) return Math.round(b / 1048576) + 'M';
    if (b > 1024) return Math.round(b / 1024) + 'K';
    return b + 'B';
}
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function pad(s, n)   { return String(s).padEnd(n); }
function padL(s, n)  { return String(s).padStart(n); }

// Render a single inner box row (IW-2 usable chars between the side spaces)
function boxLine(content) {
    const inner   = IW - 2;
    const raw     = String(content);
    const visible = stripAnsi(raw).length;
    const padded  = raw + ' '.repeat(Math.max(0, inner - visible));
    return '│ ' + padded + ' │';
}

// ---------------- Linux /proc sampler ----------------
function readCpuTotal() {
    const first = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
    return first.trim().split(/\s+/).slice(1).reduce((a, x) => a + Number(x), 0);
}

function readMemInfo() {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => Number(txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'))[1]) * 1024;
    const total = get('MemTotal');
    const avail = /^MemAvailable/m.test(txt) ? get('MemAvailable') : get('MemFree');
    return { total, used: total - avail };
}

function linuxSample(prevByPid, prevTotal) {
    const total = readCpuTotal();
    const list = [];
    const byPid = new Map();
    for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === SELF_PID) continue;
        try {
            const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            const lp = stat.indexOf('('), rp = stat.lastIndexOf(')');
            const name = stat.slice(lp + 1, rp);
            const f = stat.slice(rp + 2).split(' ');
            const ticks = Number(f[11]) + Number(f[12]);      // utime + stime
            const starttime = Number(f[19]);
            let rss = 0;
            try { rss = Number(fs.readFileSync('/proc/' + pid + '/statm', 'utf8').split(' ')[1]) * 4096; } catch { }
            let cmd = name;
            try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim() || name; } catch { }
            let cpu = 0;
            const prev = prevByPid.get(pid);
            if (prev && prev.starttime === starttime && total > prevTotal) {
                cpu = ((ticks - prev.ticks) * CORES * 100) / (total - prevTotal);
                if (cpu < 0) cpu = 0;
            }
            byPid.set(pid, { ticks, starttime });
            list.push({ pid, name, cmd, cpu, rss });
        } catch { }
    }
    return { list, byPid, total };
}

// ---------------- macOS / BSD fallback (ps) ----------------
function psSample() {
    return new Promise((resolve) => {
        execFile('ps', ['-Ao', 'pid,pcpu,pmem,comm'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve([]);
            const totalMem = os.totalmem();
            const list = [];
            for (const line of stdout.trim().split('\n').slice(1)) {
                const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
                if (!m) continue;
                const pid = Number(m[1]);
                if (pid === SELF_PID) continue;
                const name = m[4].trim();
                list.push({ pid, name, cmd: name, cpu: Number(m[2]), rss: (Number(m[3]) / 100) * totalMem });
            }
            resolve(list);
        });
    });
}

// ---------------- state ----------------
let procs = [];
let cursor = 0;
let sortMode = 'cpu';                    // cpu | mem | pid | name
let query = '';
let typing = false;
let confirmKill = null;                  // {pid, name, sig}
let flash = null, flashUntil = 0;
let prevByPid = new Map(), prevTotal = 0, lastTotal = 0;
let sysCpu = 0, memTotal = 1, memUsed = 0;
let ticking = false;

async function tick() {
    if (IS_LINUX) {
        const s = linuxSample(prevByPid, prevTotal);
        prevByPid = s.byPid; prevTotal = s.total;
        procs = s.list;
        const mi = readMemInfo();
        memTotal = mi.total; memUsed = mi.used;
        if (lastTotal) {
            const d = s.total - lastTotal;
            sysCpu = (d * 100) / (CLK_TCK * (TICK_MS / 1000) * CORES);
        }
        lastTotal = s.total;
    } else {
        procs = await psSample();
        memTotal = os.totalmem();
        memUsed = memTotal - os.freemem();
        sysCpu = Math.min(100, (os.loadavg()[0] / CORES) * 100);
    }
}

function visibleProcs() {
    let v = procs;
    if (query) {
        const q = query.toLowerCase();
        v = v.filter(p => p.cmd.toLowerCase().includes(q) || String(p.pid).includes(q));
    }
    const cmp = {
        cpu: (a, b) => b.cpu - a.cpu,
        mem: (a, b) => b.rss - a.rss,
        pid: (a, b) => a.pid - b.pid,
        name: (a, b) => a.name.localeCompare(b.name),
    }[sortMode];
    return [...v].sort(cmp);
}

// ---------------- render ----------------
function render() {
    const v      = visibleProcs();
    if (cursor >= v.length) cursor = Math.max(0, v.length - 1);
    const top    = v.slice(0, MAX_ROWS);
    const cpuPct = Math.round(sysCpu);
    const memPct = Math.round((memUsed / memTotal) * 100);
    const out    = [];
    out.push(HOME + HIDE_CUR);

    // Title bar: ┌─ taskmon ── cpu 34% ── mem 61% ──────┐
    const title     = `taskmon ── cpu ${cpuPct}% ── mem ${memPct}%`;
    const titleFill = Math.max(0, IW - title.length - 3);
    out.push('┌─ ' + title + ' ' + '─'.repeat(titleFill) + '┐');

    // Process rows
    if (!top.length) out.push(boxLine('  (no processes)'));
    top.forEach((p, i) => {
        const sel     = i === cursor;
        const arrow   = sel ? '>' : ' ';
        const pidStr  = padL(p.pid, 5);
        const nameStr = pad(trunc(p.name, 6), 7);
        const cmdPart = p.cmd.split('/').pop().split(' ')[0];
        const cmdStr  = pad(trunc(cmdPart, 12), 13);
        const cpuStr  = padL(p.cpu.toFixed(0) + '%', 5);
        const row     = arrow + ' ' + pidStr + '  ' + nameStr + ' ' + cmdStr + cpuStr;
        if (sel) {
            // highlighted row: reverse video
            out.push('│' + REVERSE + ' ' + pad(row, IW) + RESET + '│');
        } else {
            out.push(boxLine(row));
        }
    });

    // Fill remaining blank rows
    for (let i = top.length; i < MAX_ROWS; i++) out.push(boxLine(''));

    // Separator blank line
    out.push('│' + ' '.repeat(IW) + '│');

    // CPU bar
    const cpuBar = bar(sysCpu, 14);
    out.push(boxLine('  CPU  ' + cpuBar + '  ' + padL(cpuPct + '%', 4)));

    // MEM bar
    const memBar = bar(memPct, 14);
    out.push(boxLine('  MEM  ' + memBar + '  ' + padL(memPct + '%', 4)));

    // Bottom border
    out.push('└' + '─'.repeat(IW) + '┘');

    // Status / help
    let status;
    if (typing)
        status = 'filter> ' + query + '█';
    else if (confirmKill)
        status = 'kill PID ' + confirmKill.pid + ' (' + trunc(confirmKill.name, 14) + ')? [y/n]';
    else if (flash && Date.now() < flashUntil)
        status = flash;
    else
        status = '[↑/↓] select  [k]ill  [s]ort  [q]uit';
    out.push(status);

    process.stdout.write(out.join('\n') + '\n');
}

// ---------------- actions ----------------
function doKill({ pid, name, sig }) {
    try {
        process.kill(pid, sig);
        flash = 'sent ' + sig + ' to ' + pid + ' (' + trunc(name, 24) + ')';
    } catch (e) {
        flash = 'failed: ' + e.message;
    }
    flashUntil = Date.now() + 3000;
}

// ---------------- keyboard ----------------
function onFilterKey(data, str) {
    if (data.length === 1 && data[0] === 0x1b) { typing = false; query = ''; }   // esc: clear
    else if (data.length === 1 && data[0] === 0x0d) { typing = false; }          // enter: apply
    else if (data.length === 1 && data[0] === 0x7f) { query = query.slice(0, -1); }
    else if (data[0] >= 0x20 && data[0] < 0x7f) { query += str.replace(/[^\x20-\x7e]/g, ''); }
    cursor = 0;
    render();
}

function onKey(data) {
    const str = data.toString('utf8');
    const code = data.length === 1 ? data[0] : null;
    if (code === 0x03) return cleanup();                     // Ctrl-C
    if (typing) { onFilterKey(data, str); return; }          // 'q' goes into the filter
    if (str === 'q') return cleanup();

    if (confirmKill) {
        if (str === 'y' || str === 'Y') { const c = confirmKill; confirmKill = null; doKill(c); }
        else if (str === 'n' || str === 'N' || code === 0x1b) { confirmKill = null; }
        render(); return;
    }

    if (code === 0x1b && data[1] === 0x5b) {                 // arrows
        const v = visibleProcs();
        if (data[2] === 0x41) cursor = Math.max(0, cursor - 1);
        else if (data[2] === 0x42) cursor = Math.min(Math.max(0, v.length - 1), cursor + 1);
        render(); return;
    }

    if (str === 'k' || str === 'K') {
        const p = visibleProcs()[cursor];
        if (p) { confirmKill = { pid: p.pid, name: p.name, sig: str === 'K' ? 'SIGKILL' : 'SIGTERM' }; render(); }
        return;
    }
    if (str === 's') { sortMode = { cpu: 'mem', mem: 'pid', pid: 'name', name: 'cpu' }[sortMode]; cursor = 0; render(); return; }
    if (str === '/') { typing = true; render(); return; }
}

function cleanup() {
    clearInterval(timer);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(SHOW_CUR + RESET + '\n');
    process.exit(0);
}

// ---------------- --once (scriptable snapshot) ----------------
async function once() {
    await tick();
    const v = visibleProcs().slice(0, 25);
    console.log(pad('PID', 8) + padL('CPU%', 7) + ' ' + pad('MEM', 7) + ' ' + pad('NAME', 18) + 'COMMAND');
    for (const p of v)
        console.log(pad(p.pid, 8) + padL(p.cpu.toFixed(1), 7) + ' ' + pad(fmtBytes(p.rss), 7) + ' ' + pad(trunc(p.name, 17), 18) + trunc(p.cmd, 60));
}

// ---------------- main ----------------
let timer = null;
if (process.argv.includes('--once')) {
    once().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
    if (!process.stdin.isTTY) { console.error('taskmon: needs a TTY (or use --once)'); process.exit(1); }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    process.stdout.write(CLR_SCR + HIDE_CUR);
    tick().then(render).catch(() => { });
    timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        tick().then(render).catch(() => { }).finally(() => { ticking = false; });
    }, TICK_MS);
}