import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { parseImport, newAccount, publicAccount, AuthorizationQueue } from './accounts.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const directory = process.env.ACCOUNT_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(directory, 0o700);
const keyPath = path.join(directory, 'vault.key');
if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
const key = fs.readFileSync(keyPath);
const vault = path.join(directory, 'accounts.enc');
let accounts = [];
if (fs.existsSync(vault)) {
  const bytes = fs.readFileSync(vault);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  accounts = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  for (const account of accounts) {
    if (account.status === 'authorizing') {
      account.status = 'needs_auth';
      account.message = '上次任务被中断，请重新授权';
    }
  }
}
function save() {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(accounts)), cipher.final()]);
  fs.writeFileSync(`${vault}.tmp`, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
  fs.renameSync(`${vault}.tmp`, vault);
}
const queue = new AuthorizationQueue(accounts, save);
const port = Number(process.env.PORT || 4317);
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请使用 JSON 请求');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('文件大小需小于 2 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function selectedIds(input) {
  if (!Array.isArray(input.ids) || !input.ids.length) throw new Error('请先选择账号');
  const ids = [...new Set(input.ids)];
  if (ids.some(id => !accounts.some(account => account.id === id))) throw new Error('部分账号已不存在，请刷新');
  return ids;
}
let excelExportRunning = false;
function exportExcel(records) {
  return new Promise((resolve, reject) => {
    const runtime = process.execPath;
    const child = spawn(runtime, [path.join(root, 'excel/export.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.once('error', () => { clearTimeout(timer); reject(new Error('Excel 导出进程启动失败，请检查 Node.js 和依赖安装')); });
    child.once('close', code => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      if (code === 0 && buffer.subarray(0, 2).toString() === 'PK') resolve(buffer);
      else reject(new Error('Excel 文件生成失败，请稍后重试'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(records));
  });
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' data:");
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Host 不允许' });
  if (req.headers.origin && !allowedHosts.map(host => `http://${host}`).includes(req.headers.origin)) return json(res, 403, { error: '跨站请求已拒绝' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '跨站请求已拒绝' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return json(res, 200, { accounts: accounts.map(publicAccount), queue: queue.snapshot() });
    }
    if (url.pathname === '/api/import' && req.method === 'POST') {
      if (queue.running) return json(res, 409, { error: '请先停止队列再导入' });
      const input = await body(req);
      const rows = parseImport(String(input.text || ''));
      let added = 0;
      let updated = 0;
      for (const row of rows) {
        const existing = accounts.find(item => item.email === row.email);
        if (existing) {
          existing.password = row.password || existing.password;
          existing.twofa = row.twofa || existing.twofa;
          updated++;
        } else { accounts.push(newAccount(row)); added++; }
      }
      save();
      return json(res, 200, { added, updated });
    }
    if (url.pathname === '/api/jobs' && req.method === 'POST') {
      if (queue.running) return json(res, 409, { error: '已有队列正在执行' });
      const input = await body(req);
      const ids = selectedIds(input);
      if (!['authorize', 'check'].includes(input.mode)) throw new Error('任务类型有误');
      queue.start(ids, input.mode);
      return json(res, 202, { queued: ids.length });
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      await body(req);
      await queue.stop();
      return json(res, 200, { stopped: true });
    }
    if (url.pathname === '/api/export' && req.method === 'POST') {
      const ids = selectedIds(await body(req));
      const selected = accounts.filter(item => ids.includes(item.id));
      const valid = selected.filter(item => publicAccount(item).exportable);
      if (!valid.length) return json(res, 409, { error: '所选账号没有有效 session，请先授权或检查状态' });
      return json(res, 200, {
        version: 1, exportedAt: new Date().toISOString(),
        accounts: valid.map(item => ({ email: item.email, plan: item.plan, ...item.session })),
        skipped: selected.filter(item => !valid.includes(item)).map(item => ({ email: item.email, reason: '未取得有效会话或尚未通过检查' }))
      });
    }
    if (url.pathname === '/api/export-excel' && req.method === 'POST') {
      if (excelExportRunning) return json(res, 409, { error: '已有 Excel 正在生成，请稍后重试' });
      const ids = selectedIds(await body(req));
      const records = accounts.filter(account => ids.includes(account.id)).map(account => ({
        email: account.email, password: account.password, twofa: account.twofa,
        plan: account.plan, phone: account.phone, subscription: account.subscription
      }));
      excelExportRunning = true;
      try {
        const file = await exportExcel(records);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="gpt-accounts.xlsx"',
          'Content-Length': file.length,
          'Cache-Control': 'no-store'
        });
        return res.end(file);
      } finally { excelExportRunning = false; }
    }
    if (url.pathname === '/api/delete' && req.method === 'POST') {
      if (queue.running) return json(res, 409, { error: '请先停止队列再删除' });
      const ids = selectedIds(await body(req));
      for (let index = accounts.length - 1; index >= 0; index--) if (ids.includes(accounts[index].id)) accounts.splice(index, 1);
      save();
      return json(res, 200, { deleted: ids.length });
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, mime] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(root, 'public', file)));
    }
    json(res, 404, { error: '未找到该接口' });
  } catch (error) {
    // Import errors include row numbers only, never echo passwords or raw input.
    const message = error instanceof SyntaxError ? 'JSON 格式有误' : error.code?.startsWith('CSV_') ? 'CSV 格式有误，请检查引号和列数' : error.message;
    json(res, 400, { error: message?.includes('ENOSPC') ? '磁盘空间不足' : message });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`GPT Account Manager · http://127.0.0.1:${port}`));
async function shutdown() { await queue.stop(); server.close(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
