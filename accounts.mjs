import { randomUUID, createHmac } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));

export function parseImport(text) {
  let rows;
  const input = text.trim();
  if (!input) throw new Error('请先粘贴或选择账号文件');
  if (input.startsWith('[') || input.startsWith('{')) {
    const json = JSON.parse(input);
    rows = Array.isArray(json) ? json : json.accounts;
    if (!Array.isArray(rows)) throw new Error('JSON 必须是数组或包含 accounts 数组');
  } else if (input.includes('----')) {
    rows = input.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const [email, password, twofa = ''] = line.split('----');
      return { email, password, twofa };
    });
  } else {
    const delimiter = input.split(/\r?\n/)[0].includes('\t') ? '\t' : ',';
    const records = parse(input, { delimiter, skip_empty_lines: true, bom: true, relax_column_count: false });
    const hasHeader = /^(email|邮箱)$/i.test(records[0]?.[0]?.trim());
    rows = records.slice(hasHeader ? 1 : 0).map(([email, password, twofa = '']) => ({ email, password, twofa }));
  }
  if (!rows.length || rows.length > 1000) throw new Error('每次支持导入 1–1000 个账号');
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`第 ${index + 1} 行格式有误`);
    const email = String(row.email || '').trim().toLowerCase();
    const password = String(row.password || '');
    let twofa = String(row.twofa || row.totp || row['2fa'] || '').trim();
    if (twofa.startsWith('otpauth://')) twofa = new URL(twofa).searchParams.get('secret') || '';
    twofa = twofa.replace(/[\s=-]/g, '').toUpperCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`第 ${index + 1} 行邮箱有误`);
    if (twofa && !/^[A-Z2-7]{16,}$/.test(twofa)) throw new Error(`第 ${index + 1} 行 2FA 密钥格式有误`);
    return { email, password, twofa };
  });
}

export function totp(secret, time = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
  const bytes = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

export function newAccount(input) {
  return { ...input, id: randomUUID(), status: 'pending', plan: 'unknown', message: '', checkedAt: null, session: null };
}

export function publicAccount(account) {
  const { id, email, plan, checkedAt, session } = account;
  let { status, message } = account;
  const sessionExpires = session?.auth?.expires || null;
  if (status === 'ready' && !(Date.parse(sessionExpires) > Date.now())) {
    status = 'needs_auth';
    message = '保存的会话已到期，请重新授权';
  }
  const phone = account.phone || { status: 'unknown', message: '尚未查询手机信息，请检查状态', source: null, checkedAt: null };
  const subscription = account.subscription || { status: 'unknown', expiresAt: null, source: null, checkedAt: null };
  return { id, email, status, plan, message, checkedAt, sessionExpires, phone, subscription,
    hasPassword: Boolean(account.password), has2fa: Boolean(account.twofa),
    hasSession: Boolean(session), exportable: Boolean(session && status === 'ready' && Date.parse(sessionExpires) > Date.now()) };
}

export class AuthorizationQueue {
  constructor(accounts, save) {
    this.accounts = accounts;
    this.save = save;
    this.jobs = [];
    this.running = false;
    this.cancelled = false;
    this.worker = null;
  }
  snapshot() {
    return { running: this.running, jobs: this.jobs.map(job => ({ ...job })), current: this.jobs.find(job => job.state === 'running')?.id || null };
  }
  start(ids, mode) {
    if (this.running) throw new Error('已有任务正在执行，请等待或停止当前队列');
    this.cancelled = false;
    this.jobs = ids.map(id => ({ id, mode, state: 'queued' }));
    this.running = true;
    this.execute().catch(() => {}).finally(() => { this.running = false; });
  }
  async stop() {
    this.cancelled = true;
    this.worker?.kill('SIGTERM');
  }
  request(account, mode) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.env.ACCOUNT_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [path.join(root, 'protocol/worker.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.worker = child;
      let buffer = '';
      let result;
      let failure = 'HTTP 登录进程未返回有效会话';
      const timeout = setTimeout(() => { failure = 'HTTP 授权超时，请检查网络或稍后重试'; child.kill('SIGTERM'); }, 420000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) { failure = '响应超过大小限制'; child.kill(); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.event === 'step') account.message = event.message;
            if (event.event === 'result') result = event.result;
            if (event.event === 'error') failure = event.message;
          } catch { failure = '授权进程返回格式有误'; }
        }
      });
      child.once('error', () => { clearTimeout(timeout); reject(new Error('未安装 HTTP 授权依赖，请先运行 npm run setup')); });
      child.once('close', () => {
        clearTimeout(timeout);
        this.worker = null;
        if (result && !this.cancelled) resolve(result);
        else reject(new Error(this.cancelled ? '授权已停止' : failure));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ email: account.email, password: account.password, twofa: account.twofa, session: account.session, mode }));
    });
  }
  async execute() {
    try {
      for (const job of this.jobs) {
        if (this.cancelled) { job.state = 'cancelled'; continue; }
        const account = this.accounts.find(item => item.id === job.id);
        if (!account) { job.state = 'cancelled'; continue; }
        job.state = 'running';
        account.status = 'authorizing';
        account.message = job.mode === 'authorize' && !account.session ? '正在通过 HTTP 建立网页登录会话' : '正在检查已有 Session，有效则跳过重复授权';
        this.save();
        try {
          if (job.mode === 'check' && !account.session) {
            account.status = 'needs_auth';
            account.message = '尚未授权，请先执行批量授权';
            job.state = 'done';
            continue;
          }
          const result = await this.request(account, job.mode);
          const auth = result?.session?.auth;
          if (!auth?.accessToken || auth.user?.email?.toLowerCase() !== account.email || !(Date.parse(auth.expires) > Date.now())) throw new Error('Session 响应未通过邮箱和有效期检查');
          account.session = result.session;
          account.plan = result.plan || 'unknown';
          account.subscription = result.subscription || { status: 'unknown', expiresAt: null, source: null, checkedAt: null };
          account.phone = result.phone || { status: 'unknown', message: '接口未返回手机信息', source: null, checkedAt: null };
          account.status = 'ready';
          const skipped = job.mode === 'authorize' && result.authorizationSkipped === true;
          account.message = skipped ? '已有有效 Session，已跳过重复授权' : account.plan === 'unknown' ? '会话有效，套餐接口未返回可识别数据' : 'HTTP 会话检查通过';
          job.state = skipped ? 'skipped' : 'done';
        } catch (error) {
          account.status = this.cancelled ? 'needs_auth' : 'error';
          account.message = error.message;
          job.state = this.cancelled ? 'cancelled' : 'failed';
        } finally {
          account.checkedAt = new Date().toISOString();
          this.save();
        }
      }
    } finally { this.running = false; }
  }
}
