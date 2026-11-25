/**
 * 端口扫描 — 纯函数解析 + 子进程采集分离, 方便单测.
 *
 * 采集统一走"重定向到临时文件再读": 受限环境里直接 pipe 子进程输出会被拒
 * (EPERM), 重定向到文件在沙箱内外都稳.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT = 15_000;

export async function runToFile(file, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'port-board-'));
  const outFile = path.join(dir, 'out.txt');
  let handle = null;
  try {
    // 直接以 fd 作为 stdout: 不走 shell, 没有引号/转义问题, 也不触发 pipe 限制
    handle = await fsp.open(outFile, 'w');
    const child = spawn(file, args, { stdio: ['ignore', handle.fd, 'ignore'], windowsHide: true });

    let spawnError = null;
    child.once('error', (err) => { spawnError = err; });
    const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, timeout);

    const result = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeout + 1000)),
    ]);
    clearTimeout(timer);

    await handle.close();
    handle = null;

    if (spawnError) throw new Error(`无法执行 ${file}: ${spawnError.code || spawnError.message}`);
    if (result.timedOut) throw new Error(`${file} 执行超时`);

    const text = await fsp.readFile(outFile, 'utf8');
    if (!text && result.code) throw new Error(`${file} 退出码 ${result.code}`);
    return text;
  } finally {
    if (handle) await handle.close().catch(() => {});
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function recordPort(found, port, addr, pid, processName) {
  const cleanAddr = String(addr || '').trim();
  const existing = found.get(port);
  if (!existing) {
    found.set(port, {
      port,
      pid,
      addr: cleanAddr,
      addrs: cleanAddr ? [cleanAddr] : [],
      processName,
    });
    return;
  }
  if (cleanAddr && !existing.addrs.includes(cleanAddr)) {
    existing.addrs.push(cleanAddr);
    // 优先展示通配监听地址 (0.0.0.0 / * / ::), 方便一眼识别对外暴露
    if (/^(0\.0\.0\.0|\*|::)$/.test(cleanAddr) && !/^(0\.0\.0\.0|\*|::)$/.test(existing.addr)) {
      existing.addr = cleanAddr;
    }
  }
  if (!existing.pid && pid) existing.pid = pid;
  if (!existing.processName && processName) existing.processName = processName;
}

export function parseWindowsNetstat(text) {
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1];
    const pid = Number(parts[parts.length - 1]);
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || !port) continue;
    const addr = local.slice(0, idx).replace(/^\[|\]$/g, '');
    recordPort(found, port, addr, pid, null);
  }
  return found;
}

export function parseTasklist(text) {
  const byPid = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","(\d+)"/);
    if (m) byPid.set(Number(m[2]), m[1]);
  }
  return byPid;
}

export function parseLsof(text) {
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const last = parts[parts.length - 1];
    const name = /^\(LISTEN\)$/i.test(last) ? parts[parts.length - 2] : last;
    const pid = Number(parts[1]);
    const idx = name.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number(name.slice(idx + 1));
    if (!Number.isInteger(port) || !port) continue;
    recordPort(found, port, name.slice(0, idx), pid, parts[0]);
  }
  return found;
}

export function parseSs(text) {
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/LISTEN\s+\S+\s+\S+\s+(\S+):(\d+)\s/);
    if (!m) continue;
    const port = Number(m[2]);
    if (!port) continue;
    const pidMatch = line.match(/pid=(\d+)/);
    const nameMatch = line.match(/users:\(\("([^"]+)"/);
    recordPort(
      found,
      port,
      m[1],
      pidMatch ? Number(pidMatch[1]) : null,
      nameMatch ? nameMatch[1] : null,
    );
  }
  return found;
}

/** 执行命令, 只关心退出码 (用于 taskkill 这类无输出需求的动作) */
export async function runCommand(file, args, { timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    let spawnError = null;
    child.once('error', (err) => { spawnError = err; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, timeout);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? (spawnError ? -1 : null),
        signal,
        error: spawnError ? (spawnError.code || spawnError.message) : null,
      });
    });
  });
}

/** 返回 [{ port, addr, pid, processName }] */
export async function listeningPorts() {
  if (process.platform === 'win32') {
    const found = parseWindowsNetstat(await runToFile('netstat', ['-ano', '-p', 'tcp']));
    const tasklist = await runToFile('tasklist', ['/FO', 'CSV', '/NH']).catch(() => '');
    const byPid = parseTasklist(tasklist);
    for (const item of found.values()) item.processName = byPid.get(item.pid) || null;
    return [...found.values()];
  }
  if (process.platform === 'darwin') {
    return [...parseLsof(await runToFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])).values()];
  }
  return [...parseSs(await runToFile('ss', ['-ltnp'])).values()];
}

export function parseWindowsProcessStats(text, nowMs, prevMap, cpuCount = 1) {
  const result = new Map();
  const cores = Math.max(1, cpuCount || 1);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidRaw, memRaw, cpuRaw] = trimmed.split('|');
    const pid = Number(pidRaw);
    const memBytes = Number(memRaw);
    const cpuSec = Number(cpuRaw);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    let cpuPercent = null;
    if (Number.isFinite(cpuSec) && prevMap) {
      const prev = prevMap.get(pid);
      if (prev && nowMs > prev.at && cpuSec >= prev.cpuSec) {
        const dtSec = (nowMs - prev.at) / 1000;
        const pct = ((cpuSec - prev.cpuSec) / (dtSec * cores)) * 100;
        cpuPercent = Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
      }
      prevMap.set(pid, { cpuSec, at: nowMs });
    }

    result.set(pid, {
      memBytes: Number.isFinite(memBytes) && memBytes >= 0 ? memBytes : null,
      cpuPercent,
    });
  }
  return result;
}

export function parsePosixProcessStats(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const rssKb = Number(parts[1]);
    const cpu = Number(parts[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    result.set(pid, {
      memBytes: Number.isFinite(rssKb) && rssKb >= 0 ? rssKb * 1024 : null,
      cpuPercent: Number.isFinite(cpu) && cpu >= 0 ? Math.round(cpu * 10) / 10 : null,
    });
  }
  return result;
}

const prevWinCpu = new Map();

/** 采集指定 PID 列表的内存 (bytes) 与 CPU 占用 (%) */
export async function sampleProcessStats(pids) {
  const unique = [...new Set((pids || []).map(Number).filter((p) => Number.isInteger(p) && p > 0))];
  if (!unique.length) return new Map();

  if (process.platform === 'win32') {
    const cmd = `Get-Process -Id ${unique.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.WorkingSet64)|$($_.CPU)" }`;
    const text = await runToFile('powershell', ['-NoProfile', '-Command', cmd], { timeout: 8000 }).catch(() => '');
    return parseWindowsProcessStats(text, Date.now(), prevWinCpu, os.cpus().length || 1);
  }

  const text = await runToFile('ps', ['-o', 'pid=,rss=,%cpu=', '-p', unique.join(',')], { timeout: 8000 }).catch(() => '');
  return parsePosixProcessStats(text);
}

export function parseWindowsCmdlines(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf('|');
    if (sep <= 0) continue;
    const pid = Number(trimmed.slice(0, sep));
    const cmd = trimmed.slice(sep + 1).trim();
    if (Number.isInteger(pid) && pid > 0 && cmd) result.set(pid, cmd);
  }
  return result;
}

export function parsePosixCmdlines(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isInteger(pid) && pid > 0) result.set(pid, m[2].trim());
  }
  return result;
}

/** 采集指定 PID 的完整命令行 */
export async function sampleProcessCmdlines(pids) {
  const unique = [...new Set((pids || []).map(Number).filter((p) => Number.isInteger(p) && p > 0))];
  if (!unique.length) return new Map();

  if (process.platform === 'win32') {
    const filter = unique.map((p) => `ProcessId=${p}`).join(' OR ');
    const cmd = `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`;
    const text = await runToFile('powershell', ['-NoProfile', '-Command', cmd], { timeout: 8000 }).catch(() => '');
    return parseWindowsCmdlines(text);
  }

  const text = await runToFile('ps', ['-o', 'pid=,args=', '-p', unique.join(',')], { timeout: 8000 }).catch(() => '');
  return parsePosixCmdlines(text);
}

/** 校验实际进程命令行是否匹配预期指纹 (未设指纹或无法采集时视为匹配) */
export function matchesFingerprint(fingerprint, actualCmdline) {
  const fp = String(fingerprint || '').trim().toLowerCase();
  const actual = String(actualCmdline || '').trim().toLowerCase();
  if (!fp || !actual) return true;
  if (actual.includes(fp) || fp.includes(actual)) return true;
  // 提取非通用标志的关键 token (如脚本名 server.py / server.js / cadrecon.studio) 做匹配
  const tokens = fp.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t.length >= 3 && !t.startsWith('-') && !/^(node|node\.exe|python|python3|python\.exe|py|cmd|powershell|bash|sh)$/i.test(path.basename(t)));
  if (!tokens.length) return true;
  return tokens.some((t) => actual.includes(path.basename(t).toLowerCase()));
}
