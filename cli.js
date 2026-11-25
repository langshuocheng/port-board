#!/usr/bin/env node
/**
 * PortBoard CLI — 给 agent / 脚本用的小客户端.
 *
 *   node cli.js report --name dashboard --port 3000 [--url http://127.0.0.1:3000]
 *   node cli.js list [--json]
 *   node cli.js scan [--json]
 *   node cli.js rm <name|id>
 *   node cli.js check <name|id>
 *
 * 环境变量: PORTBOARD_SERVER (默认 http://127.0.0.1:8888), PORTBOARD_TOKEN
 */
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';

const args = process.argv.slice(2);
const command = args[0];
const flags = {};
for (let i = 1; i < args.length; i += 1) {
  const token = args[i];
  if (token.startsWith('--')) {
    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  } else if (!flags._) {
    flags._ = token;
  }
}

const SERVER = String(flags.server || process.env.PORTBOARD_SERVER || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TOKEN = String(flags.token || process.env.PORTBOARD_TOKEN || '').trim();

function headers(extra = {}) {
  const h = { ...extra };
  if (TOKEN) h['x-portboard-token'] = TOKEN;
  return h;
}

function call(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(SERVER + reqPath);
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = headers(payload
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {});

    const req = lib.request(target, { method, headers: reqHeaders, timeout: 25_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = data && data.error ? data.error : `HTTP ${res.statusCode}`;
          reject(new Error(message));
          return;
        }
        resolve(data);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function pad(text, width) {
  const s = String(text ?? '');
  const len = [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - len));
}

function fmtAge(iso) {
  if (!iso) return '-';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return '今天';
  return `${days}天前`;
}

function statusLabel(entry) {
  if (entry.lastStatus === 'running') return '● 运行中';
  if (entry.lastStatus === 'stopped') return '○ 已停止';
  if (entry.lastStatus === 'never') return '· 从未运行';
  return '? 未知';
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`PortBoard CLI

用法:
  node cli.js report --name <名称> --port <端口> [--url <url>] [--command <启动命令>]
                     [--cwd <目录>] [--note <备注>] [--owner <会话/agent>]
                     [--status running|stopped|never|unknown] [--pid <pid>]
  node cli.js list [--json]
  node cli.js scan [--json]
  node cli.js check <名称|id>
  node cli.js logs <名称|id> [--lines 150]
  node cli.js start <名称|id>
  node cli.js stop <名称|id> --yes
  node cli.js restart <名称|id> --yes
  node cli.js rm <名称|id>

全局: --server http://127.0.0.1:8888  --token <token>
环境变量: PORTBOARD_SERVER, PORTBOARD_TOKEN`);
    return;
  }

  if (command === 'report') {
    if (!flags.name || !flags.port) {
      throw new Error('report 需要 --name 和 --port');
    }
    const body = {
      name: flags.name,
      port: Number(flags.port),
      url: flags.url,
      command: flags.command,
      cwd: flags.cwd,
      note: flags.note,
      owner: flags.owner,
      status: flags.status || 'running',
      pid: flags.pid ? Number(flags.pid) : undefined,
      source: 'agent',
    };
    const entry = await call('POST', '/api/report', body);
    console.log(`已上报: ${entry.name} :${entry.port} [${entry.lastStatus}] id=${entry.id}`);
    return;
  }

  if (command === 'list') {
    const data = await call('GET', '/api/state');
    if (flags.json) {
      console.log(JSON.stringify(data.entries, null, 2));
      return;
    }
    const entries = [...data.entries].sort((a, b) => {
      const rank = { running: 0, stopped: 1, never: 2, unknown: 3 };
      return (rank[a.lastStatus] ?? 9) - (rank[b.lastStatus] ?? 9) || a.port - b.port;
    });
    console.log(pad('状态', 12) + pad('端口', 8) + pad('名称', 24) + pad('最近在跑', 12) + '备注');
    console.log('-'.repeat(88));
    for (const e of entries) {
      console.log(
        pad(statusLabel(e), 12)
        + pad(e.port, 8)
        + pad(e.name, 24)
        + pad(fmtAge(e.lastSeenRunningAt), 12)
        + (e.note || ''),
      );
    }
    if (!entries.length) console.log('(空)');
    return;
  }

  if (command === 'scan') {
    const scan = await call('POST', '/api/scan');
    if (flags.json) {
      console.log(JSON.stringify(scan, null, 2));
      return;
    }
    console.log(pad('端口', 8) + pad('进程', 24) + pad('PID', 9) + '地址');
    console.log('-'.repeat(64));
    for (const item of scan.ports) {
      console.log(
        pad(item.port, 8)
        + pad(item.processName || '?', 24)
        + pad(item.pid ?? '-', 9)
        + item.addr,
      );
    }
    if (!scan.ports.length) console.log('(未发现监听端口)');
    if (scan.error) console.log('扫描错误: ' + scan.error);
    return;
  }

  if (command === 'stop' || command === 'start' || command === 'restart') {
    const target = flags._;
    if (!target) throw new Error(`${command} 需要一个名称或 id`);
    if (command !== 'start' && !flags.yes && process.env.PORTBOARD_ASSUME_YES !== '1') {
      throw new Error(`${command} 会结束进程, 确认请加 --yes`);
    }
    const data = await call('GET', '/api/state');
    const entries = data.entries || [];
    const entry = entries.find((e) => e.id === target)
      || entries.find((e) => e.name.toLowerCase() === String(target).toLowerCase());
    if (!entry) throw new Error('找不到条目: ' + target);

    const result = await call('POST', `/api/entries/${encodeURIComponent(entry.id)}/${command}`, {
      confirm: entry.name,
    });
    const detail = result.detail || {};
    const extra = detail.reason ? ` (${detail.reason})` : '';
    console.log(`${command} ${entry.name} :${entry.port} -> ${result.entry.lastStatus}${extra}`);
    return;
  }

  if (command === 'check') {
    const target = flags._;
    if (!target) throw new Error('check 需要一个名称或 id');
    const data = await call('POST', `/api/entries/${encodeURIComponent(target)}/check`);
    console.log(`${data.entry.name} :${data.entry.port} -> ${data.entry.lastStatus} (${data.probe.ms}ms)`);
    return;
  }

  if (command === 'logs') {
    const target = flags._;
    if (!target) throw new Error('logs 需要一个名称或 id');
    const lines = Number(flags.lines || 150);
    const data = await call('GET', `/api/entries/${encodeURIComponent(target)}/logs?lines=${lines}`);
    if (!data.exists || !data.content) {
      console.log('(暂无托管启动日志)');
    } else {
      console.log(data.content);
    }
    return;
  }

  if (command === 'rm') {
    const target = flags._;
    if (!target) throw new Error('rm 需要一个名称或 id');
    const data = await call('DELETE', `/api/entries/${encodeURIComponent(target)}`);
    console.log('已删除 ' + data.removed);
    return;
  }

  throw new Error(`未知命令: ${command}`);
}

main().catch((err) => {
  console.error('错误: ' + err.message);
  process.exit(1);
});
