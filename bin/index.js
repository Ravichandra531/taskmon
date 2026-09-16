#!/usr/bin/env node
'use strict';

const fs  = require('fs');
const os  = require('os');
const { execFile } = require('child_process');

// ── ANSI (no colours, structural only) ──────────────────────────────────────
const ESC       = '\x1B[';
const HOME      = ESC + 'H';
const CLR_SCR   = ESC + '2J';
const CLR_END   = ESC + 'J';   // erase from cursor to end of screen
const HIDE_CUR  = ESC + '?25l';
const SHOW_CUR  = ESC + '?25h';
const REVERSE   = ESC + '7m';
const RESET     = ESC + '0m';

// ── Config ───────────────────────────────────────────────────────────────────
const TICK_MS  = 1000;
const MAX_ROWS = 5;
const IS_LINUX = fs.existsSync('/proc/stat');
const CORES    = os.cpus().length;
const SELF_PID = process.pid;
const CLK_TCK  = 100;

// Box inner content width (chars between the │ borders, NOT including them)
// Layout: │<content W chars>│  total line = W+2
const W = 42;

// ── Helpers ──────────────────────────────────────────────────────────────────
function bar(pct, len) {
    const p = Math.max(0, Math.min(100, pct));
    const f = Math.round((len * p) / 100);
    return '▓'.repeat(f) + '░'.repeat(len - f);
}
function fmtBytes(b) {
    if (b > 1073741824) return (b / 1073741824).toFixed(1) + 'G';
    if (b > 1048576)    return Math.round(b / 1048576) + 'M';
    if (b > 1024)       return Math.round(b / 1024) + 'K';
    return b + 'B';
}
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n-1) + '…' : s; }
function pad(s, n)   { return String(s).padEnd(n); }
function padL(s, n)  { return String(s).padStart(n); }

// Row helpers: every box row must be exactly W visible chars wide
function boxRow(content) {
    // content = plain string, must fit in W chars
    const s = String(content);
    return '│' + s.padEnd(W) + '│';
}
function boxRowRev(content) {
    // selected row: reverse-video the entire inner part
    const s = String(content).padEnd(W);
    return '│' + REVERSE + s + RESET + '│';
}

// ── Linux /proc sampler ───────────────────────────────────────────────────────
function readCpuTotal() {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
    return line.trim().split(/\s+/).slice(1).reduce((a, x) => a + Number(x), 0);
}
function readMemInfo() {
    const txt   = fs.readFileSync('/proc/meminfo', 'utf8');
    const get   = k => Number(txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'))[1]) * 1024;
    const total = get('MemTotal');
    const avail = /^MemAvailable/m.test(txt) ? get('MemAvailable') : get('MemFree');
    return { total, used: total - avail };
}
function linuxSample(prevByPid, prevTotal) {
    const total = readCpuTotal();
    const list  = [], byPid = new Map();
    for (const e of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(e)) continue;
        const pid = Number(e);
        if (pid === SELF_PID) continue;
        try {
            const stat      = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            const lp        = stat.indexOf('('), rp = stat.lastIndexOf(')');
            const name      = stat.slice(lp + 1, rp);
            const f         = stat.slice(rp + 2).split(' ');
            const ticks     = Number(f[11]) + Number(f[12]);
            const starttime = Number(f[19]);
            let rss = 0;
            try { rss = Number(fs.readFileSync('/proc/' + pid + '/statm', 'utf8').split(' ')[1]) * 4096; } catch {}
            let cmd = name;
            try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim() || name; } catch {}
            let cpu = 0;
            const prev = prevByPid.get(pid);
            if (prev && prev.starttime === starttime && total > prevTotal) {
                cpu = ((ticks - prev.ticks) * CORES * 100) / (total - prevTotal);
                if (cpu < 0) cpu = 0;
            }
            byPid.set(pid, { ticks, starttime });
            list.push({ pid, name, cmd, cpu, rss });
        } catch {}
    }
    return { list, byPid, total };
}

// ── macOS / BSD (ps) ─────────────────────────────────────────────────────────
function psSample() {
    return new Promise(resolve => {
        execFile('ps', ['-Ao', 'pid,pcpu,pmem,comm'], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
            if (err) return resolve([]);
            const mem  = os.totalmem();
            const list = [];
            for (const line of out.trim().split('\n').slice(1)) {
                const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
                if (!m) continue;
                const pid = Number(m[1]);
                if (pid === SELF_PID) continue;
                const name = m[4].trim();
                list.push({ pid, name, cmd: name, cpu: Number(m[2]), rss: (Number(m[3]) / 100) * mem });
            }
            resolve(list);
        });
    });
}

// ── State ─────────────────────────────────────────────────────────────────────
let procs     = [];
let cursor    = 0;
let sortMode  = 'cpu';
let query     = '';
let typing    = false;
let confirmKill = null;
let flash = null, flashUntil = 0;
let prevByPid = new Map(), prevTotal = 0, lastTotal = 0;
let sysCpu = 0, memTotal = 1, memUsed = 0;
let ticking   = false;

async function tick() {
    if (IS_LINUX) {
        const s = linuxSample(prevByPid, prevTotal);
        prevByPid = s.byPid; prevTotal = s.total; procs = s.list;
        const mi = readMemInfo();
        memTotal = mi.total; memUsed = mi.used;
        if (lastTotal) sysCpu = ((s.total - lastTotal) * 100) / (CLK_TCK * (TICK_MS / 1000) * CORES);
        lastTotal = s.total;
    } else {
        procs    = await psSample();
        memTotal = os.totalmem();
        memUsed  = memTotal - os.freemem();
        sysCpu   = Math.min(100, (os.loadavg()[0] / CORES) * 100);
    }
}

function visibleProcs() {
    let v = procs;
    if (query) {
        const q = query.toLowerCase();
        v = v.filter(p => p.cmd.toLowerCase().includes(q) || String(p.pid).includes(q));
    }
    const cmp = {
        cpu:  (a, b) => b.cpu - a.cpu,
        mem:  (a, b) => b.rss - a.rss,
        pid:  (a, b) => a.pid - b.pid,
        name: (a, b) => a.name.localeCompare(b.name),
    }[sortMode];
    return [...v].sort(cmp);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
    const v      = visibleProcs();
    if (cursor >= v.length) cursor = Math.max(0, v.length - 1);
    const top    = v.slice(0, MAX_ROWS);
    const cpuPct = Math.min(100, Math.round(sysCpu));
    const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));
    const lines  = [];

    lines.push(HOME + HIDE_CUR);

    // ── Title bar ──────────────────────────────────────────────
    // ┌─ taskmon ── cpu 34% ── mem 61% ──────┐
    // Total width = W+2 chars (same as box rows)
    const titleInner = ' taskmon \u2500\u2500 cpu ' + cpuPct + '% \u2500\u2500 mem ' + memPct + '%';
    const dashFill   = Math.max(0, W - titleInner.length - 1); // -1 for leading ┌
    lines.push('┌' + titleInner + ' ' + '─'.repeat(dashFill) + '┐');

    // ── Process rows ───────────────────────────────────────────
    // Row format (W=42 chars):
    // " > 56476  node   server.js      12%     "
    //  ^1 ^2 ^7     ^8 ^15   ^29         ^35 ^42
    // sel(1) sp(1) pid(6) sp(2) name(7) sp(1) cmd(14) cpuPct(5) padding
    if (!top.length) {
        lines.push(boxRow('  (no processes)'));
    }
    for (let i = 0; i < MAX_ROWS; i++) {
        const p = top[i];
        if (!p) { lines.push(boxRow('')); continue; }
        const sel     = i === cursor;
        const arrow   = sel ? '>' : ' ';
        const pidStr  = padL(p.pid, 6);
        const nameStr = pad(trunc(p.name, 7), 8);
        const cmdPart = p.cmd.split('/').pop().split(' ')[0];
        const cpuStr  = padL(p.cpu.toFixed(0) + '%', 5);
        // total so far: 1+1+6+1+8+1 = 18 chars before cmd, +5 for cpu = 23 + cmd
        // cmd gets: W - 23 = 19 chars
        const cmdStr  = pad(trunc(cmdPart, W - 23), W - 23);
        const row     = arrow + ' ' + pidStr + ' ' + nameStr + cmdStr + cpuStr;
        lines.push(sel ? boxRowRev(row) : boxRow(row));
    }

    // ── Blank separator ────────────────────────────────────────
    lines.push(boxRow(''));

    // ── CPU / MEM bars ─────────────────────────────────────────
    // "  CPU  ▓▓▓▓▓▓▓░░░░░░░  34%"
    // barLen so that label(7) + bar + pct(5) fits in W
    const barLen = W - 7 - 1 - 5;   // 7="  CPU  ", 1=space, 5=" 34% "
    const cpuBar = bar(sysCpu, barLen);
    const memBar = bar(memPct, barLen);
    lines.push(boxRow('  CPU  ' + cpuBar + ' ' + padL(cpuPct + '%', 4)));
    lines.push(boxRow('  MEM  ' + memBar + ' ' + padL(memPct + '%', 4)));

    // ── Bottom border ──────────────────────────────────────────
    lines.push('└' + '─'.repeat(W) + '┘');

    // ── Status line ────────────────────────────────────────────
    let status;
    if (typing)
        status = 'filter> ' + query + '█';
    else if (confirmKill)
        status = 'kill PID ' + confirmKill.pid + ' (' + trunc(confirmKill.name, 16) + ')? [y/n]';
    else if (flash && Date.now() < flashUntil)
        status = flash;
    else
        status = '[↑/↓] select  [k]ill  [s]ort  [/] filter  [q]uit';
    lines.push(status);

    // Write all at once, then clear anything below
    process.stdout.write(lines.join('\n') + '\n' + CLR_END);
}

// ── Kill ──────────────────────────────────────────────────────────────────────
function doKill({ pid, name, sig }) {
    try {
        process.kill(pid, sig);
        flash = 'sent ' + sig + ' to PID ' + pid + ' (' + trunc(name, 20) + ')';
    } catch (e) {
        flash = 'kill failed: ' + e.message;
    }
    flashUntil = Date.now() + 3000;
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
function onFilterKey(data, str) {
    if (data[0] === 0x1b)  { typing = false; query = ''; }
    else if (data[0] === 0x0d) { typing = false; }
    else if (data[0] === 0x7f) { query = query.slice(0, -1); }
    else if (data[0] >= 0x20 && data[0] < 0x7f) { query += str.replace(/[^\x20-\x7e]/g, ''); }
    cursor = 0;
    render();
}

function onKey(data) {
    const str  = data.toString('utf8');
    const code = data.length === 1 ? data[0] : null;
    if (code === 0x03) return cleanup();
    if (typing) { onFilterKey(data, str); return; }
    if (str === 'q') return cleanup();

    if (confirmKill) {
        if (str === 'y' || str === 'Y') { const c = confirmKill; confirmKill = null; doKill(c); }
        else if (str === 'n' || str === 'N' || code === 0x1b) confirmKill = null;
        render(); return;
    }

    if (data[0] === 0x1b && data[1] === 0x5b) {   // arrow keys (3-byte seq)
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
    process.stdout.write(CLR_END + SHOW_CUR + RESET + '\n');
    process.exit(0);
}

// ── --once mode ───────────────────────────────────────────────────────────────
async function once() {
    await tick();
    const v = visibleProcs().slice(0, 25);
    console.log(pad('PID', 8) + padL('CPU%', 7) + ' ' + pad('MEM', 7) + ' ' + pad('NAME', 18) + 'COMMAND');
    for (const p of v)
        console.log(pad(p.pid, 8) + padL(p.cpu.toFixed(1), 7) + ' ' + pad(fmtBytes(p.rss), 7) + ' ' + pad(trunc(p.name, 17), 18) + trunc(p.cmd, 60));
}

// ── Main ──────────────────────────────────────────────────────────────────────
let timer = null;
if (process.argv.includes('--once')) {
    once().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
    if (!process.stdin.isTTY) { console.error('taskmon: needs a TTY (or use --once)'); process.exit(1); }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    process.stdout.write(CLR_SCR + HIDE_CUR);
    tick().then(render).catch(() => {});
    timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        tick().then(render).catch(() => {}).finally(() => { ticking = false; });
    }, TICK_MS);
}
