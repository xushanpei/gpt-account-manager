const $ = selector => document.querySelector(selector);
let state = { accounts: [], queue: { jobs: [], running: false } };
const selected = new Set();
let filter = 'all';
let planFilter = 'all';
let toastTimer;
let excelExporting = false;
const statuses = { pending: '未授权', needs_auth: '需要重新授权', authorizing: '授权处理中', ready: '会话就绪', error: '连接异常' };
const planLabels = new Map([['free', 'Free'], ['plus', 'Plus'], ['pro', 'Pro'], ['team', 'Team'], ['business', 'Business'], ['enterprise', 'Enterprise'], ['edu', 'Edu'], ['unknown', '未知']]);
function accountPlan(account) { return String(account.plan ?? '').trim().toLowerCase() || 'unknown'; }
const phoneLabels = { verified: '已验证', unverified: '未验证', bound: '已关联', unknown: '未知' };
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 5000); }
async function api(route, data) {
  const response = await fetch(`/api/${route}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function visibleAccounts() {
  const search = $('#search').value.trim().toLowerCase();
  return state.accounts.filter(account => {
    const matches = filter === 'all' || account.status === filter;
    const matchesPlan = planFilter === 'all' || accountPlan(account) === planFilter;
    return matches && matchesPlan && account.email.includes(search);
  });
}
function render() {
  const accounts = state.accounts;
  const visible = visibleAccounts();
  for (const id of selected) if (!accounts.some(account => account.id === id)) selected.delete(id);
  const ready = accounts.filter(account => account.exportable).length;
  $('#total').textContent = accounts.length;
  $('#ready').textContent = ready;
  $('#pending').textContent = accounts.filter(account => ['pending', 'needs_auth', 'authorizing'].includes(account.status)).length;
  $('#errors').textContent = accounts.filter(account => account.status === 'error').length;
  $('#nav-count').textContent = accounts.length;
  $('#heading-count').textContent = accounts.length;
  const visibleIds = new Set(visible.map(account => account.id));
  const hiddenSelected = accounts.filter(account => selected.has(account.id) && !visibleIds.has(account.id)).length;
  $('#selection-text').textContent = `已选择 ${selected.size} 个账号${hiddenSelected ? `（含 ${hiddenSelected} 个筛选外账号）` : ''}`;
  for (const button of document.querySelectorAll('#status-filters button')) {
    const value = button.dataset.filter;
    const count = value === 'all' ? accounts.length : accounts.filter(account => account.status === value).length;
    button.querySelector('.filter-count').textContent = count;
    button.classList.toggle('selected', value === filter);
    button.setAttribute('aria-pressed', String(value === filter));
  }
  const planCounts = new Map([...planLabels.keys()].map(plan => [plan, 0]));
  for (const account of accounts) {
    const plan = accountPlan(account);
    planCounts.set(plan, (planCounts.get(plan) || 0) + 1);
  }
  if (planFilter !== 'all' && !planCounts.has(planFilter)) planCounts.set(planFilter, 0);
  const planOptions = ['all', ...planCounts.keys()];
  const existingPlans = [...document.querySelectorAll('#plan-filters button')].map(button => button.dataset.plan);
  if (JSON.stringify(existingPlans) !== JSON.stringify(planOptions)) {
    $('#plan-filters').innerHTML = planOptions.map(plan => `<button type="button" data-plan="${escape(plan)}" aria-pressed="false"><span>${escape(plan === 'all' ? '全部套餐' : planLabels.get(plan) || plan)}</span><span class="filter-count">0</span></button>`).join('');
  }
  for (const button of document.querySelectorAll('#plan-filters button')) {
    const plan = button.dataset.plan;
    button.querySelector('.filter-count').textContent = plan === 'all' ? accounts.length : planCounts.get(plan);
    button.classList.toggle('selected', plan === planFilter);
    button.setAttribute('aria-pressed', String(plan === planFilter));
  }
  $('#table-count').textContent = `显示 ${visible.length} / ${accounts.length} 个账号`;
  $('#select-all').checked = visible.length > 0 && visible.every(account => selected.has(account.id));
  $('#select-all').indeterminate = visible.some(account => selected.has(account.id)) && !$('#select-all').checked;
  $('#empty').hidden = Boolean(visible.length);
  if (!visible.length && accounts.length) {
    $('#empty h3').textContent = '没有匹配的账号';
    $('#empty p').textContent = '试试其他状态、套餐或邮箱关键词。';
    $('#empty-import').hidden = true;
    $('#empty small').hidden = true;
  } else {
    $('#empty h3').textContent = '把账号集中到一个工作台';
    $('#empty p').textContent = '导入邮箱、密码与 2FA 密钥，即可开始管理。';
    $('#empty-import').hidden = false;
    $('#empty small').hidden = false;
  }
  $('#account-rows').innerHTML = visible.map(account => `<tr><td><input type="checkbox" data-id="${account.id}" ${selected.has(account.id) ? 'checked' : ''} aria-label="选择 ${escape(account.email)}"></td><td class="email">${escape(account.email)}</td><td title="${escape(account.message)}"><span class="badge ${escape(account.status)}"><span>●</span>${escape(statuses[account.status] || account.status)}</span></td><td><span class="plan">${escape(planLabels.get(accountPlan(account)) || accountPlan(account))}</span></td><td class="${account.has2fa ? 'twofa' : 'muted'}">${account.has2fa ? '✓ 已配置' : '—'}</td><td title="${escape(account.phone?.message || '尚未查询手机信息')}"><span class="${['verified', 'bound'].includes(account.phone?.status) ? 'twofa' : 'muted'}">${phoneLabels[account.phone?.status] || '未知'}</span></td><td>${account.checkedAt ? new Date(account.checkedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</td><td><div class="row-actions"><button data-action="authorize" data-id="${account.id}" ${state.queue.running ? 'disabled' : ''}>授权 ↗</button><button data-action="detail" data-id="${account.id}">详情</button></div></td></tr>`).join('');
  for (const id of ['check-button', 'authorize-button', 'delete-button']) $(`#${id}`).disabled = !selected.size || state.queue.running;
  $('#excel-button').disabled = !selected.size || excelExporting;
  $('#export-button').disabled = !accounts.some(account => selected.has(account.id) && account.exportable);
  $('#import-button').disabled = state.queue.running;
  $('#stop-button').hidden = !state.queue.running;
  const jobs = state.queue.jobs;
  const complete = jobs.filter(job => !['queued', 'running'].includes(job.state)).length;
  $('#queue-count').textContent = jobs.filter(job => ['running', 'queued'].includes(job.state)).length;
  $('#queue-badge').textContent = state.queue.running ? '执行中' : jobs.length ? '已结束' : '空闲';
  const current = accounts.find(account => account.id === state.queue.current);
  $('#queue-summary').textContent = state.queue.running ? `已处理 ${complete} / ${jobs.length} · ${current?.email || '正在准备'} · ${current?.message || ''}` : jobs.length ? `已处理 ${complete} / ${jobs.length} · 成功 ${jobs.filter(job => job.state === 'done').length} · 跳过 ${jobs.filter(job => job.state === 'skipped').length} · 失败 ${jobs.filter(job => job.state === 'failed').length} · 已取消 ${jobs.filter(job => job.state === 'cancelled').length}` : '选择账号后点击「批量授权」，将在后台通过 HTTP 依次完成登录。';
  const labels = { queued: '等待', running: '处理中', done: '完成', skipped: '跳过重复授权', failed: '失败', cancelled: '已取消' };
  $('#queue-jobs').innerHTML = jobs.map(job => `<span class="job ${job.state}">${escape(accounts.find(account => account.id === job.id)?.email || '已删除')} · ${labels[job.state]}</span>`).join('');
}
async function refresh() {
  try { state = await api('state'); render(); $('#updated').textContent = `同步于 ${new Date().toLocaleTimeString('zh-CN')}`; $('.server-label').lastChild.textContent = ' Local workspace'; }
  catch { $('#updated').textContent = '连接中断，请检查本地服务'; $('.server-label').lastChild.textContent = ' 服务已断开'; }
}
function openImport() { $('#import-error').textContent = ''; $('#import-dialog').showModal(); }
$('#import-button').onclick = openImport;
$('#empty-import').onclick = openImport;
$('#guide-button').onclick = () => $('#guide-dialog').showModal();
document.querySelectorAll('dialog .close').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#import-file').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { $('#import-error').textContent = '文件大小需小于 2 MB'; return; }
  $('#import-text').value = await file.text();
};
$('#import-form').onsubmit = async event => {
  event.preventDefault();
  $('#import-submit').disabled = true;
  try {
    const result = await api('import', { text: $('#import-text').value });
    $('#import-dialog').close();
    $('#import-text').value = '';
    $('#import-file').value = '';
    await refresh();
    toast(`导入完成，新增 ${result.added} 个，更新 ${result.updated} 个`);
  } catch (error) { $('#import-error').textContent = error.message; }
  finally { $('#import-submit').disabled = false; }
};
$('#select-all').onchange = event => { for (const account of visibleAccounts()) event.target.checked ? selected.add(account.id) : selected.delete(account.id); render(); };
$('#account-rows').onchange = event => { const id = event.target.dataset.id; if (!id) return; event.target.checked ? selected.add(id) : selected.delete(id); render(); };
$('#account-rows').onclick = event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const account = state.accounts.find(item => item.id === button.dataset.id);
  if (button.dataset.action === 'authorize') start('authorize', [account.id]);
  else {
    $('#detail-email').textContent = account.email;
    $('#detail-status').textContent = account.message || '尚未检查';
    $('#detail-phone').textContent = `${phoneLabels[account.phone?.status] || '未知'} · ${account.phone?.message || '尚未查询手机信息'}`;
    $('#detail-phone-source').textContent = account.phone?.checkedAt ? `${account.phone.source || '账号接口'} · ${new Date(account.phone.checkedAt).toLocaleString('zh-CN')}` : '尚未查询';
    $('#detail-plan-expires').textContent = account.subscription?.expiresAt ? new Date(account.subscription.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : account.subscription?.status === 'not_applicable' ? '不适用' : '未知，请检查状态获取最新信息';
    $('#detail-expires').textContent = account.sessionExpires ? new Date(account.sessionExpires).toLocaleString('zh-CN') : '尚无会话';
    $('#detail-dialog').showModal();
  }
};
$('#status-filters').onclick = event => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  filter = button.dataset.filter;
  render();
};
$('#plan-filters').onclick = event => {
  const button = event.target.closest('button[data-plan]');
  if (!button) return;
  planFilter = button.dataset.plan;
  render();
};
$('#search').oninput = render;
$('#refresh-button').onclick = refresh;
$('#queue-nav').onclick = () => $('#queue-panel').scrollIntoView({ behavior: 'smooth' });
async function start(mode, ids = [...selected]) {
  try { const result = await api('jobs', { ids, mode }); await refresh(); toast(`已加入队列，共 ${result.queued} 个账号`); }
  catch (error) { toast(error.message); }
}
$('#check-button').onclick = () => start('check');
$('#authorize-button').onclick = () => start('authorize');
$('#stop-button').onclick = async () => { try { await api('stop', {}); await refresh(); toast('正在停止队列'); } catch (error) { toast(error.message); } };
$('#delete-button').onclick = async () => {
  if (!confirm(`删除选中的 ${selected.size} 个账号及其本机凭据？`)) return;
  try { await api('delete', { ids: [...selected] }); selected.clear(); await refresh(); toast('已删除所选账号'); }
  catch (error) { toast(error.message); }
};
$('#export-button').onclick = async () => {
  try {
    const result = await api('export', { ids: [...selected] });
    const sessions = result.accounts.map(account => account.auth);
    const output = sessions.length === 1 ? sessions[0] : sessions;
    const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `gpt-sessions-${new Date().toLocaleDateString('sv-SE')}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${result.accounts.length} 个会话${result.skipped.length ? `，跳过 ${result.skipped.length} 个无效会话` : ''}`);
  } catch (error) { toast(error.message); }
};
$('#excel-button').onclick = async () => {
  const ids = [...selected];
  excelExporting = true;
  $('#excel-button').disabled = true;
  $('#excel-button').textContent = '正在生成…';
  try {
    const response = await fetch('/api/export-excel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    if (!response.ok) throw new Error((await response.json()).error || 'Excel 导出失败');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gpt-accounts-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}.xlsx`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${ids.length} 个账号的 Excel`);
  } catch (error) { toast(error.message); }
  finally { excelExporting = false; $('#excel-button').textContent = '↓ 导出 Excel'; render(); }
};
await refresh();
setInterval(refresh, 2000);
