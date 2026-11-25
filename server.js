#!/usr/bin/env node
/**
 * PortBoard — local service / port board.
 *
 * 职责:
 *   1. 扫描本机监听端口, 映射 PID / 进程名
 *   2. 手工登记服务 (不依赖扫描)
 *   3. 让 agent 通过 HTTP 上报服务状态 (POST /api/report)
 *   4. 周期性探活, 维护 running / stopped-before / never 三态与"最近一次在跑"时间
 *
 * 零依赖, 只监听 127.0.0.1.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listeningPorts,
  runCommand,
  sampleProcessStats,
  sampleProcessCmdlines,
  matchesFingerprint,
} from './lib/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = '127.0.0.1';
const PORT = process.env.PORTBOARD_PORT !== undefined && process.env.PORTBOARD_PORT !== ''
  ? Number(process.env.PORTBOARD_PORT)
  : 8888;
const TOKEN = String(process.env.PORTBOARD_TOKEN || '').trim();
const SWEEP_MS = Number(process.env.PORTBOARD_SWEEP_MS ?? 60_000);
const MAX_BODY = 64 * 1024;
const MAX_LOG_BYTES = 512 * 1024;

const STATE_DIR = process.env.PORTBOARD_HOME || defaultHome();
const STATE_FILE = path.join(STATE_DIR, 'registry.json');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROBE_TIMEOUT_MS = 700;

// ---------------------------------------------------------------- state

let state = { version: 1, updatedAt: null, entries: [], ignoredPorts: [], settings: { sweepMs: SWEEP_MS }, events: [] };
let lastScan = null; // { at, ports: [...], error }
let saveChain = Promise.resolve();
const sseClients = new Set();

function pushEvent(type, entry, message) {
  state.events.unshift({
    at: nowIso(),
    type,
    entryId: entry?.id || null,
    name: entry?.name || '',
    port: entry?.port || null,
    message,
  });
  if (state.events.length > 50) state.events.length = 50;
}

function broadcast(event, payload = {}) {
  if (!sseClients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

function defaultHome() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'dsh', 'port-board');
  }
  return path.join(os.homedir(), 'dsh', 'port-board');
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return 'svc_' + crypto.randomBytes(5).toString('hex');
}

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      const savedSweep = parsed.settings && typeof parsed.settings.sweepMs === 'number'
        ? parsed.settings.sweepMs
        : SWEEP_MS;
      state = {
        version: 1,
        updatedAt: parsed.updatedAt || null,
        entries: parsed.entries,
        ignoredPorts: Array.isArray(parsed.ignoredPorts)
          ? [...new Set(parsed.ignoredPorts.map(Number).filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535))].sort((a, b) => a - b)
          : [],
        settings: { sweepMs: savedSweep },
        events: Array.isArray(parsed.events) ? parsed.events.slice(0, 50) : [],
      };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[port-board] 读取状态失败, 以空表启动:', err.message);
    }
  }
}

function saveState() {
  // 串行化写入, 避免并发 rename 互相覆盖
  saveChain = saveChain.then(async () => {
    state.updatedAt = nowIso();
    const tmp = STATE_FILE + '.' + process.pid + '.tmp';
    await fsp.mkdir(STATE_DIR, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fsp.rename(tmp, STATE_FILE);
    broadcast('state', { updatedAt: state.updatedAt });
  }).catch((err) => {
    console.error('[port-board] 保存状态失败:', err.message);
  });
  return saveChain;
}

// ---------------------------------------------------------------- probe

function tcpProbe(port, host = '127.0.0.1', timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, host, error });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err.code || err.message));
    socket.connect(port, host);
  });
}

async function probePort(port) {
  const v4 = await tcpProbe(port, '127.0.0.1');
  if (v4.ok) return v4;
  const v6 = await tcpProbe(port, '::1');
  return v6.ok ? v6 : v4;
}

function httpProbe(rawUrl) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const req = lib.request(parsed, {
      method: 'GET',
      timeout: 1500,
      headers: { 'user-agent': 'port-board/0.1' },
    }, (res) => {
      res.resume();
      finish({ ok: res.statusCode < 500, status: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      finish({ ok: false, error: err.code || err.message });
    });
    req.end();
  });
}

// ---------------------------------------------------------------- scan

async function scanPorts() {
  const startedAt = Date.now();
  try {
    const found = await listeningPorts();
    const ports = found
      .map((item) => ({
        port: item.port,
        addr: item.addr || '',
        addrs: item.addrs || (item.addr ? [item.addr] : []),
        pid: Number.isInteger(item.pid) ? item.pid : null,
        processName: item.processName || null,
        registered: state.entries.some((e) => e.port === item.port),
      }))
      .sort((a, b) => a.port - b.port);

    lastScan = { at: nowIso(), ms: Date.now() - startedAt, ports, error: null };
  } catch (err) {
    lastScan = { at: nowIso(), ms: Date.now() - startedAt, ports: [], error: String(err.message || err) };
  }
  broadcast('scan', { at: lastScan.at });
  return lastScan;
}

// ---------------------------------------------------------------- control

/** 这些进程一律不碰: 杀了会让系统/桌面出问题 */
const PROTECTED = new Set([
  'system', 'system idle process', 'idle', 'registry', 'memory compression',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe',
  'svchost.exe', 'fontdrvhost.exe', 'dwm.exe', 'explorer.exe', 'sihost.exe', 'spoolsv.exe',
]);
const ALLOW_SYSTEM = process.env.PORTBOARD_ALLOW_SYSTEM === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ownerOfPort(port) {
  try {
    const list = await listeningPorts();
    return list.find((item) => item.port === port) || null;
  } catch {
    return null;
  }
}

function assertKillable(entry) {
  if (entry.port === PORT) throw new ValidationError('不能停止 PortBoard 自身');
  if (!ALLOW_SYSTEM && entry.port < 1024) {
    throw new ValidationError('系统端口 (<1024) 默认受保护; 确需操作请设 PORTBOARD_ALLOW_SYSTEM=1');
  }
}

async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 4) throw new ValidationError('无效的 pid');
  if (process.platform === 'win32') {
    const result = await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
    if (result.error) throw new Error(`无法执行 taskkill: ${result.error}`);
    if (result.code !== 0) throw new Error(`taskkill 失败 (exit ${result.code})`);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  await sleep(1200);
  try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

async function runStopCommand(entry) {
  if (!entry.stopCommand) return false;
  await new Promise((resolve) => {
    const child = spawn(entry.stopCommand, {
      cwd: entry.cwd || undefined,
      shell: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve();
    }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  for (let i = 0; i < 10; i += 1) {
    if (!(await probePort(entry.port)).ok) return true;
    await sleep(300);
  }
  return !(await probePort(entry.port)).ok;
}

async function stopEntry(entry) {
  assertKillable(entry);
  const owner = await ownerOfPort(entry.port);
  if (!owner) {
    entry.lastStatus = entry.lastSeenRunningAt ? 'stopped' : 'never';
    entry.lastCheckedAt = nowIso();
    await saveState();
    return { stopped: false, reason: '端口当前没有监听, 无需停止' };
  }
  if (owner.pid === process.pid) throw new ValidationError('拒绝停止 PortBoard 自身');
  const name = String(owner.processName || '').toLowerCase();
  if (owner.pid <= 4 || PROTECTED.has(name)) {
    throw new ValidationError(`拒绝停止受保护进程 ${owner.processName || 'pid ' + owner.pid}`);
  }
  const fp = entry.processFingerprint || entry.command;
  if (fp) {
    const cmds = await sampleProcessCmdlines([owner.pid]).catch(() => new Map());
    const actualCmd = cmds.get(owner.pid);
    if (actualCmd && !matchesFingerprint(fp, actualCmd)) {
      entry.portConflict = true;
      entry.conflictDetail = actualCmd;
      await saveState();
      throw new ValidationError(`端口 ${entry.port} 当前被其他进程占用 (${owner.processName || 'pid ' + owner.pid})，已阻止停止`);
    }
  }

  let graceful = false;
  if (entry.stopCommand) {
    graceful = await runStopCommand(entry);
  }
  if (!graceful) {
    await killTree(owner.pid);
    for (let i = 0; i < 10; i += 1) {
      if (!(await probePort(entry.port)).ok) break;
      await sleep(300);
    }
  }

  entry.lastStatus = entry.lastSeenRunningAt ? 'stopped' : 'never';
  entry.lastCheckedAt = nowIso();
  entry.pid = null;
  entry.processName = null;
  entry.memBytes = null;
  entry.cpuPercent = null;
  entry.portConflict = false;
  entry.conflictDetail = '';
  entry.updatedAt = nowIso();
  pushEvent('stop', entry, `已停止${graceful ? ' (优雅)' : ''}`);
  await saveState();
  return { stopped: true, graceful, pid: owner.pid, processName: owner.processName };
}

function parseEnvText(envText) {
  const extra = {};
  for (const raw of String(envText || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) extra[key] = val;
  }
  return extra;
}

async function prepareLogFd(entry) {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${entry.id}.log`);
  let flag = 'a';
  try {
    const st = await fsp.stat(logPath);
    if (st.size > MAX_LOG_BYTES) flag = 'w';
  } catch { /* 新文件 */ }
  const fd = fs.openSync(logPath, flag);
  fs.writeSync(fd, `\n=== [${nowIso()}] start: ${entry.command} ===\n`);
  return { fd, logPath };
}

async function readEntryLogs(entry, maxLines = 150) {
  const logPath = entry.logFile ? String(entry.logFile) : path.join(LOG_DIR, `${entry.id}.log`);
  try {
    const raw = await fsp.readFile(logPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const tail = lines.slice(-Math.max(1, Math.min(maxLines, 500))).join('\n');
    return { exists: true, logPath, content: tail, totalLines: lines.length };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, logPath, content: '', totalLines: 0 };
    throw err;
  }
}

async function startEntry(entry) {
  if (!entry.command) throw new ValidationError('这条没有登记启动命令, 无法启动');
  const already = await ownerOfPort(entry.port);
  if (already) {
    return { started: false, reason: '端口已在监听', pid: already.pid };
  }

  const { fd: logFd } = await prepareLogFd(entry);
  let spawnErr = null;
  let child;
  try {
    const extraEnv = parseEnvText(entry.env);
    child = spawn(entry.command, {
      cwd: entry.cwd || undefined,
      env: { ...process.env, ...extraEnv },
      shell: true,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.on('error', (err) => { spawnErr = err; });
    child.unref();
  } finally {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  }

  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    if (spawnErr) throw new Error(`启动进程失败: ${spawnErr.message}`);
    if ((await probePort(entry.port)).ok) {
      const owner = await ownerOfPort(entry.port);
      entry.lastStatus = 'running';
      entry.lastSeenRunningAt = nowIso();
      entry.lastCheckedAt = nowIso();
      entry.portConflict = false;
      entry.conflictDetail = '';
      if (owner) {
        entry.pid = owner.pid;
        entry.processName = owner.processName || null;
      }
      if (entry.url) {
        const httpRes = await httpProbe(entry.url);
        entry.lastHttp = httpRes.status ?? null;
      }
      entry.updatedAt = nowIso();
      pushEvent('start', entry, `已启动 (pid ${entry.pid ?? '?'})`);
      await saveState();
      return { started: true, pid: entry.pid ?? null };
    }
  }
  throw new Error('启动后 20 秒内端口仍未监听 (可查看日志或检查 command / cwd)');
}

async function restartEntry(entry) {
  await stopEntry(entry);
  return startEntry(entry);
}

// ---------------------------------------------------------------- entries

class ValidationError extends Error {}

function cleanString(value, maxLen = 400) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maxLen);
}

function normalizeEntry(input, prev) {
  const base = prev || {};
  const name = cleanString(input.name ?? base.name, 80);
  if (!name) throw new ValidationError('name 不能为空');

  const portRaw = input.port ?? base.port;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('port 必须是 1-65535 的整数');
  }

  const status = input.status ?? base.lastStatus ?? 'unknown';
  const allowed = new Set(['running', 'stopped', 'never', 'unknown']);
  if (!allowed.has(status)) throw new ValidationError('status 取值: running | stopped | never | unknown');

  return {
    name,
    port,
    url: cleanString(input.url ?? base.url, 300),
    command: cleanString(input.command ?? base.command, 600),
    stopCommand: cleanString(input.stopCommand ?? base.stopCommand, 600),
    cwd: cleanString(input.cwd ?? base.cwd, 300),
    env: cleanString(input.env ?? base.env, 2000),
    logFile: cleanString(input.logFile ?? base.logFile, 300),
    processFingerprint: cleanString(input.processFingerprint ?? base.processFingerprint, 400),
    note: cleanString(input.note ?? base.note, 600),
    owner: cleanString(input.owner ?? base.owner, 200),
    source: cleanString(input.source ?? base.source, 20) || 'manual',
    lastStatus: status,
  };
}

function findEntry(idOrName) {
  return state.entries.find((e) => e.id === idOrName)
    || state.entries.find((e) => e.name.toLowerCase() === String(idOrName).toLowerCase());
}

function upsertFromReport(body) {
  const name = cleanString(body.name, 80);
  if (!name) throw new ValidationError('name 不能为空');
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('port 必须是 1-65535 的整数');
  }

  const key = cleanString(body.key, 200) || `${name.toLowerCase()}::${port}`;
  let entry = state.entries.find((e) => e.key === key)
    || state.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());

  const status = body.status ?? 'running';
  const now = nowIso();

  if (!entry) {
    entry = {
      id: newId(),
      key,
      createdAt: now,
      lastSeenRunningAt: null,
      lastCheckedAt: null,
      lastHttp: null,
      ...normalizeEntry({ ...body, source: body.source || 'agent', status }, {}),
    };
    state.entries.push(entry);
  } else {
    Object.assign(entry, normalizeEntry({ ...body, source: entry.source || 'agent', status }, entry));
    entry.key = key;
  }

  entry.updatedAt = now;
  if (status === 'running') entry.lastSeenRunningAt = now;
  if (body.pid != null) entry.pid = Number(body.pid) || null;
  if (body.processName) entry.processName = cleanString(body.processName, 120);

  return entry;
}

function publicEntry(entry) {
  return { ...entry };
}

function summary() {
  const s = { total: state.entries.length, running: 0, stoppedBefore: 0, never: 0, unknown: 0 };
  for (const e of state.entries) {
    if (e.lastStatus === 'running') s.running += 1;
    else if (e.lastStatus === 'stopped') s.stoppedBefore += 1;
    else if (e.lastStatus === 'never') s.never += 1;
    else s.unknown += 1;
  }
  return s;
}

let lastResourceSampleAt = null;

function resourcesSummary() {
  const seenPids = new Set();
  let memBytes = 0;
  let cpuPercent = 0;
  let hasCpu = false;
  let processCount = 0;

  for (const e of state.entries) {
    if (e.lastStatus !== 'running') continue;
    const key = Number.isInteger(e.pid) && e.pid > 0 ? `pid:${e.pid}` : `entry:${e.id}`;
    if (seenPids.has(key)) continue;
    seenPids.add(key);
    if (typeof e.memBytes === 'number') {
      memBytes += e.memBytes;
      processCount += 1;
    }
    if (typeof e.cpuPercent === 'number') {
      cpuPercent += e.cpuPercent;
      hasCpu = true;
    }
  }

  return {
    memBytes,
    cpuPercent: hasCpu ? Math.round(cpuPercent * 10) / 10 : null,
    processCount,
    sampledAt: lastResourceSampleAt,
  };
}

// ---------------------------------------------------------------- sweep

let sweepTimer = null;

async function sweep() {
  if (!state.entries.length) return;
  const listeners = new Map(
    (await listeningPorts().catch(() => [])).map((item) => [item.port, item]),
  );
  await Promise.all(state.entries.map(async (entry) => {
    const prevStatus = entry.lastStatus;
    const prevPid = entry.pid;
    const res = await probePort(entry.port);
    entry.lastCheckedAt = nowIso();
    if (res.ok) {
      entry.lastStatus = 'running';
      entry.lastSeenRunningAt = nowIso();
      entry.lastProbeMs = res.ms;
      const owner = listeners.get(entry.port);
      if (owner) {
        if (prevPid && owner.pid && prevPid !== owner.pid && prevStatus === 'running') {
          pushEvent('pid_change', entry, `PID 变更: #${prevPid} -> #${owner.pid}`);
        }
        entry.pid = owner.pid;
        entry.processName = owner.processName || null;
      }
      if (prevStatus === 'stopped' || prevStatus === 'never' || prevStatus === 'unknown') {
        pushEvent('up', entry, `恢复运行 (pid ${entry.pid ?? '?'})`);
      }
      if (entry.url) {
        const httpRes = await httpProbe(entry.url);
        entry.lastHttp = httpRes.status ?? null;
      }
    } else {
      // 曾经被观测到在跑 -> stopped-before; 登记后从未跑过 -> never
      entry.lastStatus = entry.lastSeenRunningAt ? 'stopped' : 'never';
      if (prevStatus === 'running') {
        pushEvent('down', entry, '检测到服务已停止');
      }
      entry.pid = null;
      entry.memBytes = null;
      entry.cpuPercent = null;
      entry.portConflict = false;
      entry.conflictDetail = '';
    }
  }));

  const runningPids = state.entries
    .filter((e) => e.lastStatus === 'running' && Number.isInteger(e.pid) && e.pid > 0)
    .map((e) => e.pid);
  const [stats, cmdlines] = await Promise.all([
    sampleProcessStats(runningPids).catch(() => new Map()),
    sampleProcessCmdlines(runningPids).catch(() => new Map()),
  ]);
  lastResourceSampleAt = nowIso();
  for (const entry of state.entries) {
    if (entry.lastStatus !== 'running') continue;
    const st = entry.pid ? stats.get(entry.pid) : null;
    entry.memBytes = st ? st.memBytes : null;
    entry.cpuPercent = st ? st.cpuPercent : null;

    const actualCmd = entry.pid ? cmdlines.get(entry.pid) : null;
    if (actualCmd) {
      const fp = entry.processFingerprint || entry.command;
      if (!fp) {
        entry.processFingerprint = actualCmd.slice(0, 300);
        entry.portConflict = false;
        entry.conflictDetail = '';
      } else {
        const ok = matchesFingerprint(fp, actualCmd);
        if (!ok && !entry.portConflict) {
          pushEvent('conflict', entry, `端口疑似被其他进程占用 (${entry.processName || 'pid ' + entry.pid})`);
        }
        entry.portConflict = !ok;
        entry.conflictDetail = ok ? '' : actualCmd;
      }
    }
  }

  await saveState();
}

function startSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  const ms = Number(state.settings?.sweepMs ?? SWEEP_MS);
  if (!ms || ms <= 0) return;
  sweepTimer = setInterval(() => {
    sweep().catch((err) => console.error('[port-board] 探活失败:', err.message));
  }, Math.max(ms, 5000));
  sweepTimer.unref?.();
}

// ---------------------------------------------------------------- http

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-portboard-token');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
}

function json(res, code, data) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(data);
  cors(res);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function authorized(req, url) {
  if (!TOKEN) return true;
  return req.headers['x-portboard-token'] === TOKEN || url.searchParams.get('token') === TOKEN;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ValidationError('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('请求体不是合法 JSON');
  }
}

async function serveStatic(res, filePath) {
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: '非法请求路径' });
  }
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, time: nowIso(), version: '0.1.0' });
    }
    if (pathname === '/api/events' && method === 'GET') {
      if (!authorized(req, url)) return json(res, 401, { error: '需要 token (x-portboard-token)' });
      cors(res);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();
      res.write(`event: ready\ndata: ${JSON.stringify({ at: nowIso() })}\n\n`);
      sseClients.add(res);
      const keepalive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(keepalive); sseClients.delete(res); }
      }, 25_000);
      keepalive.unref?.();
      req.on('close', () => {
        clearInterval(keepalive);
        sseClients.delete(res);
      });
      return;
    }
    if (pathname === '/api/state' && method === 'GET') {
      const addr = server.address();
      const selfPort = addr && typeof addr === 'object' ? addr.port : PORT;
      return json(res, 200, {
        serverTime: nowIso(),
        selfPort,
        tokenRequired: Boolean(TOKEN),
        stateFile: STATE_FILE,
        entries: state.entries.map(publicEntry),
        ignoredPorts: state.ignoredPorts,
        settings: state.settings,
        events: state.events,
        summary: summary(),
        resources: resourcesSummary(),
        lastScan,
      });
    }

    if (!authorized(req, url)) {
      return json(res, 401, { error: '需要 token (x-portboard-token)' });
    }

    if (pathname === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      const ms = Number(body.sweepMs);
      if (!Number.isFinite(ms) || (ms !== 0 && (ms < 5000 || ms > 3_600_000))) {
        throw new ValidationError('sweepMs 必须是 0 (关闭) 或 5000 ~ 3600000 的毫秒数');
      }
      state.settings = { ...state.settings, sweepMs: Math.round(ms) };
      startSweep();
      await saveState();
      if (state.settings.sweepMs > 0) sweep().catch(() => {});
      return json(res, 200, { ok: true, settings: state.settings });
    }

    if (pathname === '/api/scan' && method === 'POST') {
      const scan = await scanPorts();
      return json(res, 200, scan);
    }

    if (pathname === '/api/scan/ignore' && method === 'POST') {
      const body = await readBody(req);
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ValidationError('port 必须是 1-65535 的整数');
      }
      if (!state.ignoredPorts.includes(port)) {
        state.ignoredPorts = [...state.ignoredPorts, port].sort((a, b) => a - b);
        await saveState();
      }
      return json(res, 200, { ok: true, ignoredPorts: state.ignoredPorts });
    }

    const unignoreMatch = pathname.match(/^\/api\/scan\/ignore\/(\d+)$/);
    if (unignoreMatch && method === 'DELETE') {
      const port = Number(unignoreMatch[1]);
      state.ignoredPorts = state.ignoredPorts.filter((p) => p !== port);
      await saveState();
      return json(res, 200, { ok: true, ignoredPorts: state.ignoredPorts });
    }

    if (pathname === '/api/entries' && method === 'POST') {
      const body = await readBody(req);
      const normalized = normalizeEntry({ ...body, source: body.source || 'manual' }, {});
      if (state.entries.some((e) => e.port === normalized.port)) {
        throw new ValidationError(`端口 ${normalized.port} 已登记，请直接编辑现有条目`);
      }
      const entry = {
        id: newId(),
        key: `${normalized.name.toLowerCase()}::${normalized.port}`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastSeenRunningAt: normalized.lastStatus === 'running' ? nowIso() : null,
        lastCheckedAt: null,
        lastHttp: null,
        ...normalized,
      };
      state.entries.push(entry);
      const probe = await probePort(entry.port);
      entry.lastCheckedAt = nowIso();
      entry.lastStatus = probe.ok ? 'running' : 'never';
      if (probe.ok) {
        entry.lastSeenRunningAt = nowIso();
        const owner = await ownerOfPort(entry.port);
        if (owner) {
          entry.pid = owner.pid;
          entry.processName = owner.processName || null;
        }
        if (entry.url) {
          const httpRes = await httpProbe(entry.url);
          entry.lastHttp = httpRes.status ?? null;
        }
      }
      await saveState();
      return json(res, 201, entry);
    }

    if (pathname === '/api/report' && method === 'POST') {
      const body = await readBody(req);
      const entry = upsertFromReport(body);
      await saveState();
      return json(res, 200, entry);
    }

    const entryMatch = pathname.match(/^\/api\/entries\/([^/]+)$/);
    if (entryMatch) {
      const entry = findEntry(entryMatch[1]);
      if (!entry) return json(res, 404, { error: 'entry not found' });

      if (method === 'GET') return json(res, 200, entry);

      if (method === 'PATCH') {
        const body = await readBody(req);
        Object.assign(entry, normalizeEntry(body, entry));
        const probe = await probePort(entry.port);
        entry.lastCheckedAt = nowIso();
        entry.lastStatus = probe.ok ? 'running' : (entry.lastSeenRunningAt ? 'stopped' : 'never');
        if (probe.ok) {
          entry.lastSeenRunningAt = nowIso();
          if (entry.url) {
            const httpRes = await httpProbe(entry.url);
            entry.lastHttp = httpRes.status ?? null;
          }
        }
        entry.updatedAt = nowIso();
        await saveState();
        return json(res, 200, entry);
      }

      if (method === 'DELETE') {
        state.entries = state.entries.filter((e) => e.id !== entry.id);
        await saveState();
        return json(res, 200, { ok: true, removed: entry.id });
      }
    }

    const logsMatch = pathname.match(/^\/api\/entries\/([^/]+)\/logs$/);
    if (logsMatch && method === 'GET') {
      const entry = findEntry(logsMatch[1]);
      if (!entry) return json(res, 404, { error: 'entry not found' });
      const lines = Number(url.searchParams.get('lines') || 150);
      const log = await readEntryLogs(entry, Number.isFinite(lines) ? lines : 150);
      return json(res, 200, { id: entry.id, name: entry.name, ...log });
    }

    const actionMatch = pathname.match(/^\/api\/entries\/([^/]+)\/(stop|start|restart)$/);
    if (actionMatch && method === 'POST') {
      const entry = findEntry(actionMatch[1]);
      if (!entry) return json(res, 404, { error: 'entry not found' });
      const body = await readBody(req);
      if (body.confirm !== entry.name) {
        throw new ValidationError('确认失败: 请在 confirm 字段里原样传服务名');
      }
      const action = actionMatch[2];
      let detail;
      if (action === 'stop') detail = await stopEntry(entry);
      else if (action === 'start') detail = await startEntry(entry);
      else detail = await restartEntry(entry);
      return json(res, 200, { ok: true, action, entry, detail });
    }

    const checkMatch = pathname.match(/^\/api\/entries\/([^/]+)\/check$/);
    if (checkMatch && method === 'POST') {
      const entry = findEntry(checkMatch[1]);
      if (!entry) return json(res, 404, { error: 'entry not found' });
      const res1 = await probePort(entry.port);
      entry.lastCheckedAt = nowIso();
      entry.lastStatus = res1.ok ? 'running' : (entry.lastSeenRunningAt ? 'stopped' : 'never');
      if (res1.ok) entry.lastSeenRunningAt = nowIso();
      if (entry.url && res1.ok) {
        const http = await httpProbe(entry.url);
        entry.lastHttp = http.status ?? null;
      }
      await saveState();
      return json(res, 200, { entry, probe: res1 });
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    const code = err instanceof ValidationError ? 400 : 500;
    return json(res, code, { error: String(err.message || err) });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[port-board] 端口 ${PORT} 已被占用, 用 PORTBOARD_PORT 换一个`);
    process.exit(1);
  }
  throw err;
});

async function main() {
  await loadState();
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : PORT;
    startSweep();
    console.log(`[port-board] http://${HOST}:${actualPort}`);
    console.log(`[port-board] state: ${STATE_FILE}`);
    if (TOKEN) console.log('[port-board] token 已启用 (x-portboard-token)');
    sweep().then(() => {
      // Windows 首次采样只有累计 CPU 秒数, 1.5s 后补采一次即可算出实时 CPU%
      if (process.platform === 'win32' && Number(state.settings?.sweepMs ?? SWEEP_MS) > 0) {
        setTimeout(() => { sweep().catch(() => {}); }, 1500).unref?.();
      }
    }).catch(() => {});
  });
}

main();
