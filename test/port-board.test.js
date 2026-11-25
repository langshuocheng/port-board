import assert from 'node:assert';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseWindowsNetstat,
  parseTasklist,
  parseLsof,
  parseSs,
  parseWindowsProcessStats,
  parsePosixProcessStats,
  parseWindowsCmdlines,
  parsePosixCmdlines,
  matchesFingerprint,
} from '../lib/scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function reqJson(baseUrl, method, reqPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + reqPath);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers['x-portboard-token'] = token;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* text */ }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runUnitTests() {
  const winText = [
    '  TCP    127.0.0.1:8888         0.0.0.0:0              LISTENING       1234',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       5678',
    '  TCP    [::1]:3000             [::]:0                 LISTENING       5678',
    '  TCP    127.0.0.1:5000         127.0.0.1:5001         ESTABLISHED     9999',
  ].join('\r\n');
  const winMap = parseWindowsNetstat(winText);
  assert.strictEqual(winMap.size, 2);
  assert.strictEqual(winMap.get(8888).pid, 1234);
  assert.strictEqual(winMap.get(3000).addr, '0.0.0.0');
  assert.deepStrictEqual(winMap.get(3000).addrs, ['0.0.0.0', '::1']);

  const taskMap = parseTasklist('"node.exe","5678","Console","1","45,000 K"\r\n"python.exe","1234","Console","1","20,000 K"');
  assert.strictEqual(taskMap.get(5678), 'node.exe');
  assert.strictEqual(taskMap.get(1234), 'python.exe');

  const lsofMap = parseLsof('node    4321 user   22u  IPv4 0x1 0t0  TCP 127.0.0.1:9000 (LISTEN)\nnode    4321 user   23u  IPv6 0x2 0t0  TCP *:9000 (LISTEN)');
  assert.strictEqual(lsofMap.get(9000).pid, 4321);
  assert.strictEqual(lsofMap.get(9000).addr, '*');

  const ssMap = parseSs('LISTEN 0 511 127.0.0.1:7000 0.0.0.0:* users:(("python3",pid=888,fd=3))');
  assert.strictEqual(ssMap.get(7000).pid, 888);
  assert.strictEqual(ssMap.get(7000).processName, 'python3');

  const prevWin = new Map();
  const w1 = parseWindowsProcessStats('100|52428800|1.5\n', 1000, prevWin, 4);
  assert.strictEqual(w1.get(100).memBytes, 52428800);
  assert.strictEqual(w1.get(100).cpuPercent, null);
  const w2 = parseWindowsProcessStats('100|52428800|3.5\n', 11000, prevWin, 4);
  assert.strictEqual(w2.get(100).cpuPercent, 5.0);

  const p1 = parsePosixProcessStats('200 10240 2.5\n');
  assert.strictEqual(p1.get(200).memBytes, 10240 * 1024);
  assert.strictEqual(p1.get(200).cpuPercent, 2.5);

  const wCmds = parseWindowsCmdlines('123|"C:\\Python\\python.exe" server.py\n');
  assert.strictEqual(wCmds.get(123), '"C:\\Python\\python.exe" server.py');
  const pCmds = parsePosixCmdlines('456 python3 -m cadrecon.studio --port 8799\n');
  assert.strictEqual(pCmds.get(456), 'python3 -m cadrecon.studio --port 8799');
  assert.strictEqual(matchesFingerprint('python server.py', 'C:\\env\\python.exe server.py'), true);
  assert.strictEqual(matchesFingerprint('python server.py', 'C:\\node\\node.exe other.js'), false);
  console.log('✓ unit tests (scan parsers) passed');
}

async function runIntegrationTests() {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'port-board-test-'));
  const token = 'test-tok-123';
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORTBOARD_PORT: '0',
      PORTBOARD_HOME: tmpHome,
      PORTBOARD_SWEEP_MS: '0',
      PORTBOARD_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('server start timeout: ' + buf)), 8000);
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const m = buf.match(/\[port-board\] (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.stderr.on('data', (chunk) => { buf += chunk.toString('utf8'); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early (${code}): ${buf}`));
      });
    });

    const health = await reqJson(baseUrl, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.data.ok, true);

    const st = await reqJson(baseUrl, 'GET', '/api/state');
    assert.strictEqual(st.status, 200);
    assert.strictEqual(typeof st.data.resources.memBytes, 'number');
    assert.strictEqual(Array.isArray(st.data.events), true);

    const setRes = await reqJson(baseUrl, 'POST', '/api/settings', { sweepMs: 15000 }, token);
    assert.strictEqual(setRes.status, 200);
    assert.strictEqual(setRes.data.settings.sweepMs, 15000);

    const expGone = await reqJson(baseUrl, 'GET', '/api/export', null, token);
    assert.strictEqual(expGone.status, 404);

    const impGone = await reqJson(baseUrl, 'POST', '/api/import', { entries: [] }, token);
    assert.strictEqual(impGone.status, 404);

    const homePage = await reqJson(baseUrl, 'GET', '/');
    assert.strictEqual(homePage.status, 200);
    assert.match(homePage.data, /PortBoard/);

    const unauth = await reqJson(baseUrl, 'POST', '/api/entries', { name: 'x', port: 45123 });
    assert.strictEqual(unauth.status, 401);

    const created = await reqJson(baseUrl, 'POST', '/api/entries', {
      name: 'demo-app',
      port: 45123,
      url: 'http://127.0.0.1:45123',
      note: 'integration test',
    }, token);
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.data.name, 'demo-app');
    const id = created.data.id;

    const dup = await reqJson(baseUrl, 'POST', '/api/entries', { name: 'dup', port: 45123 }, token);
    assert.strictEqual(dup.status, 400);

    const reported = await reqJson(baseUrl, 'POST', '/api/report', {
      name: 'demo-app',
      port: 45123,
      note: 'updated by agent',
      status: 'running',
    }, token);
    assert.strictEqual(reported.status, 200);
    assert.strictEqual(reported.data.id, id);
    assert.strictEqual(reported.data.note, 'updated by agent');

    const logs = await reqJson(baseUrl, 'GET', `/api/entries/${id}/logs?lines=50`, null, token);
    assert.strictEqual(logs.status, 200);
    assert.strictEqual(logs.data.exists, false);

    const ign = await reqJson(baseUrl, 'POST', '/api/scan/ignore', { port: 45124 }, token);
    assert.strictEqual(ign.status, 200);
    assert.deepStrictEqual(ign.data.ignoredPorts, [45124]);

    const unign = await reqJson(baseUrl, 'DELETE', '/api/scan/ignore/45124', null, token);
    assert.strictEqual(unign.status, 200);
    assert.deepStrictEqual(unign.data.ignoredPorts, []);

    const sseOk = await new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/events?token=${token}`, (res) => {
        assert.strictEqual(res.statusCode, 200);
        res.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          if (text.includes('event: ready')) {
            req.destroy();
            resolve(true);
          }
        });
      });
      req.on('error', reject);
      setTimeout(() => reject(new Error('SSE timeout')), 3000);
    });
    assert.strictEqual(sseOk, true);

    const del = await reqJson(baseUrl, 'DELETE', `/api/entries/${id}`, null, token);
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.data.removed, id);

    console.log('✓ integration tests (server API & SSE) passed');
  } finally {
    child.kill();
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  await runUnitTests();
  await runIntegrationTests();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
