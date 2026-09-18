#!/usr/bin/env node
'use strict';

const fs  = require('fs');
const os  = require('os');
const { execFile } = require('child_process');

// ── ANSI ─────────────────────────────────────────────────────────────────────
const ESC      = '\x1B[';
const HOME     = ESC + 'H';
const CLR_SCR  = ESC + '2J';
const HIDE_CUR = ESC + '?25l';
const SHOW_CUR = ESC + '?25h';
const REVERSE  = ESC + '7m';
const RESET    = ESC + '0m';
const ALT_ON   = ESC + '?1049h';
const ALT_OFF  = ESC + '?1049l';

// ── Config ───────────────────────────────────────────────────────────────────
const IS_LINUX = fs.existsSync('/proc/stat');
const CORES    = os.cpus().length;
const SELF_PID = process.pid;
const CLK_TCK  = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────
function clip(s, n) {
    s = String(s);
    if (s.length > n) return s.slice(0, n);
    return s.padEnd(n);
}
function fmtBytes(b) {
    if (b > 1073741824) return (b / 1073741824).toFixed(1) + 'G';
    if (b > 1048576)    return Math.round(b / 1048576) + 'M';
    if (b > 1024)       return Math.round(b / 1024) + 'K';
    return b + 'B';
}
function fmtUptime(s) {
    s = Math.floor(s);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
}
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function pad(s, n)   { return String(s).padEnd(n); }
function padL(s, n)  { return String(s).padStart(n); }
function visCols()   { return Math.max(20, process.stdout.columns || 80); }
function visRows()   { return Math.max(8, process.stdout.rows || 24); }

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
    const list  = [], next = new Map();
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
            next.set(pid, { ticks, starttime });
            list.push({ pid, name, cmd, cpu, rss });
        } catch {}
    }
    return { list, byPid: next, total };
}

// ── macOS / BSD (ps) ─────────────────────────────────────────────────────────
function psSample() {
    return new Promise(resolve => {
        execFile('ps', ['-Ao', 'pid,pcpu,pmem,command'], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
            if (err) return resolve([]);
            const mem  = os.totalmem();
            const list = [];
            for (const line of out.trim().split('\n').slice(1)) {
                const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
                if (!m) continue;
                const pid = Number(m[1]);
                if (pid === SELF_PID) continue;
                const cmd = m[4].trim();
                const base = cmd.includes('/') ? cmd.split('/').pop().split(' ')[0] : cmd.split(' ')[0];
                list.push({ pid, name: base, cmd, cpu: Number(m[2]), rss: (Number(m[3]) / 100) * mem });
            }
            resolve(list);
        });
    });
}

function appNameOf(p) {
    const fromPath = String(p.cmd || '').match(/\/([^/]+)\.app\//);
    if (fromPath) return fromPath[1];
    let n = String(p.name || '').trim();
    n = n.replace(/\s+Helper(\s*\([^)]*\))?\s*$/i, '');
    n = n.replace(/\s+\([^)]*\)\s*$/, '');
    return n || p.name;
}

function groupByApp(list) {
    const map = new Map();
    for (const p of list) {
        const name = appNameOf(p);
        let g = map.get(name);
        if (!g) {
            g = { name, pid: p.pid, pids: [], cpu: 0, rss: 0, cmd: p.cmd, count: 0, helper: true, mainRss: 0 };
            map.set(name, g);
        }
        g.pids.push(p.pid);
        g.cpu += p.cpu;
        g.rss += p.rss;
        g.count++;
        const isHelper = /helper/i.test(p.name) || /Helper/.test(p.cmd);
        if ((g.helper && !isHelper) || (isHelper === g.helper && p.rss > g.mainRss)) {
            g.pid = p.pid;
            g.cmd = p.cmd;
            g.helper = isHelper;
            g.mainRss = p.rss;
        }
    }
    return [...map.values()];
}

function compareProcs(mode) {
    return {
        cpu:  (a, b) => b.cpu - a.cpu || a.name.localeCompare(b.name),
        mem:  (a, b) => b.rss - a.rss || a.name.localeCompare(b.name),
        pid:  (a, b) => a.pid - b.pid,
        name: (a, b) => a.name.localeCompare(b.name),
    }[mode];
}

// ── State ─────────────────────────────────────────────────────────────────────
let procs       = [];
let selectedName = null;
let scroll      = 0;
let sortMode    = 'name';
let query       = '';
let typing      = false;
let confirmKill = null;
let flash = null, flashUntil = 0;
let prevByPid = new Map(), prevTotal = 0, lastTotal = 0;
let sysCpu = 0, memTotal = 1, memUsed = 0;
let sampling = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tick() {
    let list;
    if (IS_LINUX) {
        let s = linuxSample(prevByPid, prevTotal);
        prevByPid = s.byPid; prevTotal = s.total; lastTotal = s.total;
        await sleep(400);
        s = linuxSample(prevByPid, prevTotal);
        prevByPid = s.byPid; prevTotal = s.total; list = s.list;
        const mi = readMemInfo();
        memTotal = mi.total; memUsed = mi.used;
        if (lastTotal) sysCpu = ((s.total - lastTotal) * 100) / (CLK_TCK * 0.4 * CORES);
        lastTotal = s.total;
    } else {
        list     = await psSample();
        memTotal = os.totalmem();
        memUsed  = memTotal - os.freemem();
        sysCpu   = Math.min(100, (os.loadavg()[0] / CORES) * 100);
    }

    const keep = selectedName;
    procs = groupByApp(list).sort(compareProcs(sortMode));
    if (keep != null && procs.some(p => p.name === keep)) selectedName = keep;
}

function visibleProcs() {
    if (!query) return procs;
    const q = query.toLowerCase();
    return procs.filter(p =>
        p.name.toLowerCase().includes(q) ||
        String(p.pid).includes(q) ||
        p.pids.some(pid => String(pid).includes(q))
    );
}

function listHeight() {
    return Math.max(1, visRows() - 3);
}

function selectedIndex(v) {
    if (!v.length) return 0;
    const i = selectedName == null ? -1 : v.findIndex(p => p.name === selectedName);
    if (i >= 0) return i;
    selectedName = v[0].name;
    return 0;
}

function moveSelection(delta) {
    const v = visibleProcs();
    if (!v.length) { selectedName = null; scroll = 0; return; }
    const i = Math.max(0, Math.min(v.length - 1, selectedIndex(v) + delta));
    selectedName = v[i].name;
}

function clampScroll(v, cursor, maxRows) {
    if (cursor < scroll) scroll = cursor;
    if (cursor >= scroll + maxRows) scroll = cursor - maxRows + 1;
    const maxScroll = Math.max(0, v.length - maxRows);
    if (scroll > maxScroll) scroll = maxScroll;
    if (scroll < 0) scroll = 0;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
    const cols = visCols();
    const rows = visRows();
    const v = visibleProcs();
    const maxRows = Math.max(1, rows - 3);
    const cursor = selectedIndex(v);
    clampScroll(v, cursor, maxRows);
    const page = v.slice(scroll, scroll + maxRows);
    const cpuPct = Math.min(100, Math.round(sysCpu));
    const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));
    const lines = [];

    lines.push('taskmon  ' + procs.length + ' apps  CPU ' + cpuPct + '%  MEM ' + memPct + '%  ' +
        fmtBytes(memUsed) + '/' + fmtBytes(memTotal));

    const nameW = Math.max(8, cols - 7 - 8 - 7);
    lines.push(pad('APP', nameW) + padL('CPU%', 7) + ' ' + pad('MEM', 8) + padL('N', 6));

    for (let i = 0; i < maxRows; i++) {
        const p = page[i];
        if (!p) { lines.push(''); continue; }
        const mark    = p.name === selectedName ? '>' : ' ';
        const nameStr = pad(trunc(p.name, Math.max(1, nameW - 1)), Math.max(1, nameW - 1));
        lines.push(mark + nameStr + padL(p.cpu.toFixed(1), 7) + ' ' + pad(fmtBytes(p.rss), 8) + padL(p.count, 6));
    }

    let status;
    if (typing)
        status = 'filter> ' + query + '_';
    else if (confirmKill)
        status = 'kill ' + confirmKill.count + ' of ' + trunc(confirmKill.name, 20) +
            ' with ' + confirmKill.sig + '? [y/n]';
    else if (flash && Date.now() < flashUntil)
        status = flash;
    else
        status = '[up/down]  [k]ill  [r]efresh  [/]filter  [q]uit';
    lines.push(status);

    const out = [];
    for (let i = 0; i < rows; i++) {
        const raw = lines[i] || '';
        const text = clip(raw, cols);
        const sel = page[i - 2] && page[i - 2].name === selectedName && i >= 2 && i < 2 + maxRows;
        out.push(sel ? REVERSE + text + RESET : text);
    }
    process.stdout.write(HOME + HIDE_CUR + out.join('\r\n'));
}

function doKill({ name, pids, sig }) {
    let ok = 0, err = null;
    for (const pid of pids) {
        try { process.kill(pid, sig); ok++; }
        catch (e) { err = e; }
    }
    if (ok) flash = 'sent ' + sig + ' to ' + ok + ' process' + (ok === 1 ? '' : 'es') + ' of ' + trunc(name, 20);
    else flash = 'kill failed: ' + (err ? err.message : 'unknown error');
    procs = procs.filter(p => p.name !== name);
    if (selectedName === name) selectedName = null;
    flashUntil = Date.now() + 4000;
}

function onFilterKey(data, str) {
    if (data.length === 1 && data[0] === 0x1b) { typing = false; query = ''; }
    else if (data[0] === 0x0d) { typing = false; }
    else if (data[0] === 0x7f) { query = query.slice(0, -1); }
    else if (data[0] >= 0x20 && data[0] < 0x7f) { query += str.replace(/[^\x20-\x7e]/g, ''); }
    render();
}

async function refresh() {
    if (sampling) return;
    sampling = true;
    flash = 'refreshing…';
    flashUntil = Date.now() + 2000;
    render();
    try {
        await tick();
        flash = 'refreshed — same app still selected';
        flashUntil = Date.now() + 2000;
        render();
    } catch (e) {
        flash = 'refresh failed: ' + e.message;
        flashUntil = Date.now() + 3000;
        render();
    } finally {
        sampling = false;
    }
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

    if (data[0] === 0x1b && data[1] === 0x5b) {
        if (data[2] === 0x41) moveSelection(-1);
        else if (data[2] === 0x42) moveSelection(1);
        else if (data[2] === 0x35) moveSelection(-listHeight());
        else if (data[2] === 0x36) moveSelection(listHeight());
        render(); return;
    }

    if (str === 'k' || str === 'K') {
        const v = visibleProcs();
        const p = v[selectedIndex(v)];
        if (p) {
            confirmKill = { name: p.name, pids: p.pids, count: p.count, sig: str === 'K' ? 'SIGKILL' : 'SIGTERM' };
            render();
        }
        return;
    }
    if (str === 's') {
        sortMode = { cpu: 'mem', mem: 'pid', pid: 'name', name: 'cpu' }[sortMode];
        const keep = selectedName;
        procs = procs.slice().sort(compareProcs(sortMode));
        selectedName = keep;
        render();
        return;
    }
    if (str === 'r') { refresh(); return; }
    if (str === '/') { typing = true; render(); return; }
}

function cleanup() {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ALT_OFF + SHOW_CUR + RESET);
    process.exit(0);
}

async function once() {
    await tick();
    const v = visibleProcs().slice(0, 25);
    console.log(pad('APP', 28) + padL('CPU%', 7) + ' ' + pad('MEM', 8) + padL('PROCS', 7));
    for (const p of v)
        console.log(pad(trunc(p.name, 27), 28) + padL(p.cpu.toFixed(1), 7) + ' ' + pad(fmtBytes(p.rss), 8) + padL(p.count, 7));
}

if (process.argv.includes('--once')) {
    once().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
    if (!process.stdin.isTTY) { console.error('taskmon: needs a TTY (or use --once)'); process.exit(1); }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    let resizeTimer = null;
    process.stdout.on('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(render, 50);
    });
    process.stdout.write(ALT_ON + CLR_SCR + HIDE_CUR);
    tick().then(render).catch(() => {});
}
