/* ============ 【miao的工作台】前端逻辑 v2 ============
 * 八大板块：首页指挥舱 / 上课 / 个辅 / 危机干预 / 教研培训 / 论文课题 / 比赛 / 事务性工作
 * 无 ServiceWorker · 服务端实时同步（版本号轮询）· 附件上传 · 周课表覆盖 · 看板
 */
'use strict';

/* ---------------- 工具 ---------------- */
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayStr(offset) {
  const d = new Date();
  if (offset) d.setDate(d.getDate() + offset);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function nowHM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatDateCN(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d)) return s;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_CN[d.getDay()];
}

// 距某日期的天数（未来为正）
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr + 'T00:00:00');
  if (isNaN(t)) return null;
  const now = new Date(todayStr() + 'T00:00:00');
  return Math.round((t - now) / 864e5);
}

// 本周周一（ISO），offset 为周偏移；周日算下一周（周日指向下周周一）
function mondayOf(offset) {
  const d = new Date();
  let day = (d.getDay() + 6) % 7;
  if (d.getDay() === 0) day = -1; // 周日：指向下周一
  d.setDate(d.getDate() - day + (offset || 0) * 7);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => { t.hidden = true; }, ms || 2000);
}

/* ---------------- 板块元数据 ---------------- */
const SECTIONS = {
  class:    { name: '上课', icon: '📚', desc: '教务管理 · 课表/备课/调课', chip: 'jw' },
  counsel:  { name: '个辅', icon: '🔒', desc: '隐私红线区 · 脱敏管理', chip: 'an', privacy: true },
  crisis:   { name: '危机干预', icon: '🚨', desc: '隐私红线区 · 最高保密', chip: 'an', privacy: true },
  research: { name: '教研培训', icon: '🎓', desc: '知识沉淀 · 学习归档', chip: 'sw' },
  paper:    { name: '论文课题', icon: '📝', desc: '学术输出 · 全流程', chip: 'sw' },
  contest:  { name: '比赛', icon: '🏆', desc: '职业发展 · 赛事/获奖', chip: 'sw' },
  admin:    { name: '事务性工作', icon: '🗂️', desc: '行政追踪 · 看板', chip: 'pv' },
  other:    { name: '其它工作', icon: '🧩', desc: '日报留痕 · 灵感捕获 · 社群课程', chip: 'pv' },
  me:       { name: '我的履历', icon: '🪪', desc: '教育/工作 · 培训 · 社群参与', chip: 'sw' },
  self:     { name: '自我关怀', icon: '💚', desc: '能量蓄水池 · 疗愈与放松', chip: 'sw' }
};

/* ---------------- API ---------------- */
let TOKEN = localStorage.getItem('wb_token') || '';
/* 静态快照模式（GitHub Pages 导出）：只读展示 */
const STATIC = typeof window !== 'undefined' && window.__STATIC__ === true;

/* 安抚银行二次门禁密码（如需更换，改这一处即可，静态站重新导出后生效） */
const COMFORT_PASS = '20262026';
const comfortUnlocked = () => sessionStorage.getItem('wb_comfort_ok') === '1';

async function api(method, path, body) {
  if (STATIC) {
    if (method === 'GET' && S.state) return S.state;
    throw new Error('静态快照为只读模式，不能修改');
  }
  const opts = { method, headers: { 'Authorization': 'Bearer ' + TOKEN } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    TOKEN = '';
    localStorage.removeItem('wb_token');
    showLogin();
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

/* ---------------- 全局状态 ---------------- */
const S = {
  state: null,
  view: 'overview',     // overview | section | settings
  section: null,
  tab: null,            // 板块内子页（模块 key 或 timetable）
  weekOffset: 0,
  search: '',
  formFiles: {},        // 表单临时附件 {fkey: [fileId]}
  pollTimer: null,
  clockTimer: null,
  docId: null,
  docDirty: false,
  docTimer: null,
  docSave: null,
  expCat: null,         // 个人经历：类别筛选
  rosterClass: '',      // 学生名册：当前选中的班级
  apOpenGroups: new Set() // 预约：展开的周期组
};

async function loadState() {
  if (STATIC) {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error('data.json 读取失败');
    S.state = await res.json();
    applyTheme();
    return S.state;
  }
  S.state = await api('GET', '/api/state');
  applyTheme();
  return S.state;
}
function bumpLocal(version) {
  if (S.state && typeof version === 'number') S.state.version = version;
}

/* ---------------- 主题与品牌 ---------------- */
function applyTheme() {
  const c = S.state.config;
  document.documentElement.style.setProperty('--theme', c.theme);
  document.documentElement.style.setProperty('--theme-soft', hexToSoft(c.theme));
  $('#metaTheme').setAttribute('content', c.theme);
  document.title = c.appName;
  const logoHtml = c.logo ? `<img src="${c.logo}" alt="logo">` : '🦢';
  $('#brandLogo').innerHTML = logoHtml;
  $('#brandName').textContent = c.appName;
  $('#loginLogo').innerHTML = logoHtml;
  $('#loginTitle').textContent = c.appName;
}
function hexToSoft(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'rgba(46,158,143,.10)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.10)`;
}
// 日程类型（与月历下方图例一致）→ 圆点颜色
const CAL_CATS = [
  ['日程', '#2E9E8F'],
  ['导师', '#2E9E8F'],          // 生涯课（导师课）：沿用日程青绿
  ['凿光', '#EFCF5B'],          // 社群活动：浅黄
  ['学习', '#74D3B4'],          // 薄荷绿
  ['合唱', '#D9A21B'],          // 金黄
  ['个案', '#3B82F6'],          // 个辅/访谈脱敏：蓝色
  ['生活', '#7BB661'],          // 草绿
  ['调课', '#7A8699'],
  ['待办', '#E8A33D'],
  ['假期', '#B08BE8']
];
function catColor(cat) {
  const k = String(cat || '').trim().replace(/[（(].*?[）)]/g, '');
  const hit = CAL_CATS.find(c => c[0].replace(/[（(].*?[）)]/g, '') === k);
  if (hit) return hit[1];
  // 兼容旧标签
  if (k === '生涯') return catColor('导师');
  if (k === '社群') return catColor('凿光');
  if (k === '生涯/社群') return catColor('导师');
  // 课程 / 工作 / 个人 / 纪念日 → 日程色
  return '#2E9E8F';
}

// 时间自动补零：9 → 09:00，930 → 09:30，13:5 → 13:05
function normalizeTime(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/[^\d:]/g, '');
  if (!s) return '';
  let h, m;
  if (s.includes(':')) {
    const parts = s.split(':');
    h = parts[0] || '0';
    m = parts[1] || '0';
  } else if (s.length <= 2) { h = s; m = '0'; }
  else if (s.length === 3) { h = s.slice(0, 1); m = s.slice(1); }
  else { h = s.slice(0, 2); m = s.slice(2, 4); }
  const hh = Math.min(23, parseInt(h, 10) || 0);
  const mm = Math.min(59, parseInt(m, 10) || 0);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

// 按标题猜日程类型（特殊情况手动改即可）
function guessCat(title) {
  const t = String(title || '');
  if (!t.trim()) return '';
  if (/个案|个辅|访谈|咨询|预约/.test(t)) return '个案';
  if (/合唱/.test(t)) return '合唱';
  if (/凿光|社群/.test(t)) return '凿光';
  if (/导师|生涯/.test(t)) return '导师';
  if (/学习|听课|读书|自习|刷题|培训/.test(t)) return '学习';
  if (/调课|代课|换课/.test(t)) return '调课';
  if (/假期|放假|节日|元旦|寒假|暑假/.test(t)) return '假期';
  if (/生活|家务|做饭|买菜|运动|跑步|健身|体检|看病|医院|家里|孩子|接娃|休息/.test(t)) return '生活';
  if (/待办|截止/.test(t)) return '待办';
  return '日程';
}

function typeColor(typeName) {
  const t = (S.state.config.courseTypes || []).find(x => x.name === typeName);
  return t ? t.color : '#7A8699';
}

/* ---------------- 登录 ---------------- */
function showLogin() {
  stopPoll(); stopClock();
  $('#app').hidden = true;
  $('#loginScreen').hidden = false;
  fetch('/api/public').then(r => r.json()).then(p => {
    if (!S.state) {
      document.documentElement.style.setProperty('--theme', p.theme || '#2E9E8F');
      document.documentElement.style.setProperty('--theme-soft', hexToSoft(p.theme));
      if (p.logo) $('#loginLogo').innerHTML = `<img src="${p.logo}" alt="logo">`;
      if (p.appName) { $('#loginTitle').textContent = p.appName; document.title = p.appName; }
    }
  }).catch(() => {});
}

async function doLogin(e) {
  e.preventDefault();
  const pw = $('#loginPassword').value;
  const btn = $('#loginBtn');
  btn.disabled = true; btn.textContent = '验证中…';
  if (STATIC) {
    try {
      if (pw && pw === window.__GATE_PASS__) {
        TOKEN = 'static'; localStorage.setItem('wb_token', 'static');
        $('#loginErr').textContent = ''; $('#loginPassword').value = '';
        await enterApp();
      } else $('#loginErr').textContent = '口令不对';
    } finally { btn.disabled = false; btn.textContent = '进入工作台'; }
    return;
  }
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '登录失败');
    TOKEN = data.token;
    localStorage.setItem('wb_token', TOKEN);
    $('#loginErr').textContent = '';
    $('#loginPassword').value = '';
    await enterApp();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = '进入工作台';
  }
}

// 支持 #/section/self/comfort 这类直达链接（从桌面或手机书签直接到某一页）
function applyHashView() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  if (!h) return;
  const p = h.split('/');
  if (p[0] === 'doc' && p[1]) { const r = S.state.records.find(x => x.id === p[1]); if (r) { S.docId = r.id; navigate('section', 'research', 'trainnote'); } return; }
  if (p[0] === 'md' && p[1]) { navigate('section', 'class', 'lesson'); setTimeout(() => openMdPreview(p[1]), 80); return; }
  if (p[0] === 'track' && p[1]) { navigate('section', 'class', 'track'); setTimeout(() => { const r = S.state.records.find(x => x.id === p[1]); if (r) openTrackView(r); }, 80); return; }
  if (p[0] === 'section' && p[1]) navigate('section', p[1], p[2]);
  else if (p[0] === 'settings') { if (!STATIC) navigate('settings'); }
  else if (p[0] === 'overview') navigate('overview');
}

async function enterApp() {
  await loadState();
  if (STATIC) document.body.classList.add('static');
  $('#loginScreen').hidden = true;
  $('#app').hidden = false;
  if (S.view === 'section' && !S.section) S.view = 'overview';
  applyHashView();
  renderNav();
  rerender();
  startPoll();
  startClock();
}

/* ---------------- 实时同步 ---------------- */
function startPoll() {
  stopPoll();
  if (STATIC) return;
  S.pollTimer = setInterval(async () => {
    if (document.hidden || !TOKEN || !S.state) return;
    try {
      const r = await api('GET', '/api/version');
      if (r.version !== S.state.version) {
        await loadState();
        rerender();
      }
      $('#syncDot').classList.remove('off');
    } catch (e) {
      $('#syncDot').classList.add('off');
    }
  }, 4000);
}
function stopPoll() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }

/* ---------------- 时间中枢时钟 ---------------- */
function startClock() {
  stopClock();
  S.clockTimer = setInterval(() => {
    const el = $('#bigClock');
    if (!el) return;
    const d = new Date();
    el.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
  }, 1000);
}
function stopClock() { if (S.clockTimer) { clearInterval(S.clockTimer); S.clockTimer = null; } }

function teachingWeek() {
  const start = new Date((S.state.config.semesterStart || '2026-08-31') + 'T00:00:00');
  const now = new Date(todayStr() + 'T00:00:00');
  if (now.getDay() === 0) now.setDate(now.getDate() + 1); // 周日算下一周
  const diff = Math.floor((now - start) / 864e5);
  return Math.max(1, Math.floor(diff / 7) + 1);
}

/* 单双周：教学周为奇数=单周(odd)，偶数=双周(even) */
function parityOfWeekNo(n) { return n % 2 === 1 ? 'odd' : 'even'; }
function weekNoOfMonday(mondayStr) {
  const start = new Date((S.state.config.semesterStart || '2026-08-31') + 'T00:00:00');
  const diff = Math.floor((new Date(mondayStr + 'T00:00:00') - start) / 864e5);
  return Math.max(1, Math.floor(diff / 7) + 1);
}
const emptyCell = () => ({ subject: '', type: '', teacher: '', room: '' });
// cell.week: '' | 'odd' | 'even'；cell.alt 为该格的交替周内容
function pickCell(cell, parity) {
  if (!cell || cell.clear) return null;
  const ok = c => (c && (c.subject || c.teacher)) ? c : null;
  if (!cell.week || cell.week === 'all' || cell.week === parity) return ok(cell);
  if (cell.alt && (!cell.alt.week || cell.alt.week === 'all' || cell.alt.week === parity)) return ok(cell.alt);
  return null;
}

/* ---------------- 导航 ---------------- */
function navGroups() {
  const sec = key => ({ id: 'section', key, icon: SECTIONS[key].icon, name: SECTIONS[key].name });
  return [
    { label: null, items: [{ id: 'overview', icon: '🏠', name: '首页 · 指挥舱' }] },
    { label: '教务', chip: 'jw', items: [sec('class')] },
    { label: '隐私红线区', chip: 'an', items: [sec('counsel'), sec('crisis')] },
    { label: '专业成长', chip: 'sw', items: [sec('research'), sec('paper'), sec('contest')] },
    { label: '个人', chip: 'sw', items: [sec('me')] },
    { label: '行政', chip: 'pv', items: [sec('admin'), sec('other')] },
    { label: '自我关怀', chip: 'sw', items: [sec('self')] },
    ...(STATIC ? [] : [{ label: '系统', chip: 'pv', items: [{ id: 'settings', icon: '🛡️', name: '设置与隐私' }] }])
  ];
}

function renderNav() {
  const groups = navGroups();
  $('#sidebar').innerHTML = groups.map(g => {
    const head = g.label ? `<div class="nav-group-label"><span class="zone-chip z-${g.chip}"></span>${g.label}</div>` : '';
    const items = g.items.map(it => {
      const act = (S.view === it.id && (it.id !== 'section' || S.section === it.key)) ? ' active' : '';
      const badge = it.badge ? `<span class="n-badge">${it.badge}</span>` : '';
      return `<button class="nav-item${act}" data-nav="${it.id}" data-key="${it.key || ''}">
        <span class="n-ic">${it.icon}</span><span>${esc(it.name)}</span>${badge}</button>`;
    }).join('');
    return head + items;
  }).join('');
}

function navigate(view, key, tab) {
  S.view = view;
  S.section = key || null;
  if (key && view === 'section') {
    const mods = S.state.config.modules.filter(m => m.section === key);
    const defaultTab = key === 'class' ? 'timetable' : key === 'other' ? 'daily' : key === 'self' ? 'quote' : (mods[0] ? mods[0].key : null);
    S.tab = tab || defaultTab;
  } else {
    S.tab = null;
  }
  S.search = '';
  if (key !== 'class') S.weekOffset = 0;
  stopNoise(); stopBreath();
  renderNav();
  rerender();
  closeDrawer();
  window.scrollTo(0, 0);
}

function rerender() {
  const main = $('#main');
  if (S.view === 'overview') main.innerHTML = viewOverview();
  else if (S.view === 'section') main.innerHTML = viewSection(S.section);
  else if (S.view === 'settings') main.innerHTML = viewSettings();
  if (S.view === 'section' && S.tab === 'trainnote') mountDocPane();
}

/* ================= 首页 · 指挥舱 ================= */
function viewOverview() {
  const st = S.state;
  const d = new Date();
  const wd = WEEK_CN[d.getDay()];
  const today = todayStr();
  const now = nowHM();

  // 假期倒计时
  const holidays = (st.config.holidays || [])
    .map(h => Object.assign({}, h, { days: daysUntil(h.date) }))
    .filter(h => h.days !== null && h.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, 5);
  const holidayChips = holidays.map(h =>
    `<span class="holiday-chip${h.days <= 7 ? ' soon' : ''}">⏳ 距${esc(h.name)}还有 <b>${h.days}</b> 天</span>`
  ).join('') || '<span class="muted-note">暂无假期倒计时，去设置里添加</span>';

  // 今日课程（学期课表 + 当周覆盖合并）
  const wk = mondayOf(0);
  const mergedNow = mergedTimetable(wk);
  const courseRows = st.config.periods.map((p, i) => {
    const m0 = mergedNow[wd] && mergedNow[wd][String(i)];
    const cell = m0 ? m0.cell : emptyCell();
    const overridden = m0 ? m0.overridden : false;
    const isNow = p.start <= now && now <= p.end;
    const filled = cell && (cell.subject || cell.teacher);
    if (!filled && !isNow) return '';
    const dot = cell.type ? `<span class="type-dot" style="background:${typeColor(cell.type)}"></span>` : '';
    const ovrMark = overridden ? ' <span class="ovr-mark">调</span>' : '';
    return `<div class="today-row${isNow ? ' now' : ''}">
      <span class="t-time">${p.start}–${p.end}</span>
      <span class="t-name">${dot}${esc(filled ? cell.subject : p.name)}${ovrMark}</span>
      ${filled && cell.teacher ? `<span class="t-class">${esc(cell.teacher)}${cell.room ? ' · ' + esc(cell.room) : ''}</span>` : ''}
    </div>`;
  }).join('');

  // 今日待办（优先级 + 临近标红）
  const openTodos = st.todos.filter(t => !t.done && t.due && t.due <= today);
  const todoRows = openTodos.slice(0, 8).map(t => {
    const du = daysUntil(t.due);
    const urgent = du !== null && du <= 1;
    const pr = { high: '高', mid: '中', low: '低' }[t.priority || 'mid'];
    const left = du === null ? '' : du > 0 ? `剩 ${du} 天` : du === 0 ? '今天截止' : `已逾期 ${-du} 天`;
    return `<div class="todo-item${t.done ? ' done' : ''}${urgent ? ' urgent' : ''}">
      <button class="todo-check" data-todo-toggle="${t.id}">✓</button>
      <span class="prio prio-${t.priority || 'mid'}">${pr}</span>
      <span class="todo-text">${esc(t.text)}</span>
      <span class="todo-due${urgent ? ' overdue' : ''}">${left}</span>
    </div>`;
  }).join('');

  // 板块速览
  const secChips = Object.keys(SECTIONS).map(k =>
    `<button class="sec-chip" data-nav="section" data-key="${k}">${SECTIONS[k].icon} ${SECTIONS[k].name}</button>`
  ).join('');

  // 最近调课
  const swaps = st.records.filter(r => r.module === 'swap').slice(0, 3);

  return `
    <div class="hero card zc-jw">
      <div class="hero-clock" id="bigClock">--:--:--</div>
      <div class="hero-date">${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${wd}
        <span class="week-badge">第 ${teachingWeek()} 教学周</span></div>
      <div class="holiday-row">${holidayChips}</div>
    </div>
    <div class="sec-chip-row">${secChips}</div>
    <div class="card zc-jw"><h3>📆 月历<span class="right">圆点 = 事件类型 · 点击日期查看</span></h3>
      ${viewMonthCalendar()}
    </div>
    <div class="card"><h3>🗓️ 今日课程 · ${esc(wd)}<span class="right">${esc(now)} · <button class="linklike" data-nav="section" data-key="class">上课板块 →</button></span></h3>
      ${courseRows || '<div class="empty"><div class="e-ic">🍃</div>今天没有课程安排</div>'}
    </div>
    <div class="card"><h3>✅ 今日待办<span class="right"><button class="linklike" data-nav="section" data-key="admin">事务看板 →</button></span></h3>
      <form id="todoQuickForm" class="todo-quick">
        <input id="todoText" placeholder="快速新增待办…" required>
        <input type="date" id="todoDue" value="${today}">
        <select id="todoPrio"><option value="high">高</option><option value="mid" selected>中</option><option value="low">低</option></select>
        <button class="btn primary sm" type="submit">添加</button>
      </form>
      <div class="todo-list-mini">${todoRows || '<div class="empty" style="padding:14px 0">今天没有待办任务 🎉</div>'}</div>
      <p class="hint">💡 截止前 1 天内的任务将自动标红提醒</p>
    </div>
    <div class="card"><h3>🔁 调课管理<span class="right"><button class="btn sm primary" id="swapQuickBtn">＋ 记录调课</button></span></h3>
      ${swaps.length ? swaps.map(r => {
        const d2 = r.data;
        return `<div class="today-row">
          <span class="t-time">${esc(d2.date || '')}</span>
          <span class="t-name">${esc(d2.orig || '')} → ${esc(d2.now || '')}</span>
          <span class="t-class">${esc(d2.clazz || '')} · <b class="${d2.notice === '已通知到位' ? 'ok-t' : 'warn-t'}">${esc(d2.notice || '')}</b></span>
        </div>`;
      }).join('') : '<div class="empty" style="padding:14px 0">暂无调课记录</div>'}
    </div>`;
}

/* ================= 板块页 ================= */
function viewSection(sectionKey) {
  const sec = SECTIONS[sectionKey];
  if (!sec) return '<div class="empty">板块不存在</div>';
  const mods = S.state.config.modules.filter(m => m.section === sectionKey);
  const tabs = [];
  if (sectionKey === 'class') tabs.push({ key: 'timetable', name: '聚合周课表', icon: '🗓️' });
  else if (sectionKey === 'other') tabs.push({ key: 'daily', name: '工作日报', icon: '📋' });
  else if (sectionKey === 'self') tabs.push({ key: 'quote', name: '疗愈金句', icon: '🌤️' }, { key: 'relax', name: '放松工具箱', icon: '🎧' });
  for (const m of mods) tabs.push({ key: m.key, name: m.name, icon: m.icon || '📁' });

  if (!tabs.some(t => t.key === S.tab)) S.tab = tabs[0] ? tabs[0].key : null;

  const tabBar = `<div class="tabbar">${tabs.map(t =>
    `<button class="tabbtn${S.tab === t.key ? ' active' : ''}" data-tab="${t.key}">${t.icon} ${esc(t.name)}</button>`
  ).join('')}</div>`;

  let body = '';
  if (S.tab === 'timetable') body = viewTimetable();
  else if (S.tab === 'daily') body = viewDailyReport();
  else if (S.tab === 'quote') body = viewQuotes();
  else if (S.tab === 'relax') body = viewRelax();
  else {
    const m = mods.find(x => x.key === S.tab);
    if (m) {
      if (m.key === 'flash') body = viewFlash(m);
      else if (m.key === 'exp') body = viewExp(m);
      else if (m.key === 'case') body = viewCase(m);
      else if (m.key === 'roster') body = viewRosterByClass(m);
      else if (m.key === 'appoint') body = viewAppoint(m);
      else if (m.key === 'comfort') body = comfortUnlocked() ? viewComfort(m) : comfortGateHtml();
      else if (m.key === 'trainnote') body = viewTrainDocs(m);
      else if (m.key === 'track') body = viewTrack(m);
      else body = m.viewMode === 'kanban' ? viewKanban(m) : viewModule(m);
    }
  }

  const banner = sec.privacy ? `<div class="privacy-banner">🔒 隐私数据，绝对保密 · 仅限本人查阅 · 数据脱敏管理，严禁外传</div>` : '';
  const wrapCls = sec.privacy ? 'privacy-zone' : '';
  return `${banner}<div class="${wrapCls}">
    <div class="sec-head"><span class="sec-ic">${sec.icon}</span><div><div class="sec-name">${esc(sec.name)}</div><div class="sec-desc">${esc(sec.desc)}</div></div></div>
    ${tabBar}
    <div class="sec-body">${body}</div>
  </div>`;
}

/* ================= 聚合周课表 ================= */
function mergedTimetable(weekKeyStr) {
  const st = S.state;
  const ovr = st.timetableOverrides[weekKeyStr] || {};
  const parity = parityOfWeekNo(weekNoOfMonday(weekKeyStr));
  const out = {};
  for (const day of st.config.workDays) {
    out[day] = {};
    st.config.periods.forEach((p, i) => {
      const o = (ovr[day] || {})[String(i)];
      const raw = (st.timetable[day] || {})[String(i)] || emptyCell();
      let cell;
      if (o !== undefined) {
        cell = o.clear ? emptyCell() : (pickCell(o, parity) || emptyCell());
      } else {
        cell = pickCell(raw, parity) || emptyCell();
      }
      out[day][String(i)] = { cell, raw, overridden: o !== undefined, parity };
    });
  }
  return out;
}

function viewTimetable() {
  const st = S.state;
  const wk = mondayOf(S.weekOffset);
  const tt = mergedTimetable(wk);
  const d = new Date();
  const todayWd = WEEK_CN[d.getDay()];
  const isThisWeek = S.weekOffset === 0;
  const weekNo = (() => {
    const start = new Date((st.config.semesterStart || '2026-08-31') + 'T00:00:00');
    const diff = Math.floor((new Date(wk + 'T00:00:00') - start) / 864e5);
    return Math.max(1, Math.floor(diff / 7) + 1);
  })();

  const legend = (st.config.courseTypes || []).map(t =>
    `<span class="legend-item"><span class="type-dot" style="background:${t.color}"></span>${esc(t.name)}</span>`).join('');

  const header = `<tr><th style="width:96px">节次 / 时间</th>${st.config.workDays.map(day =>
    `<th class="day${isThisWeek && day === todayWd ? ' today' : ''}">${esc(day)}</th>`).join('')}</tr>`;

  const bodyRows = st.config.periods.map((p, i) => {
    const tds = st.config.workDays.map(day => {
      const { cell, overridden } = tt[day][i];
      const filled = cell.subject || cell.teacher || cell.type;
      const color = typeColor(cell.type);
      return `<td><div class="tt-cell${filled ? ' filled' : ''}" data-cell="${day}|${i}" style="${filled && cell.type ? `border-left:3px solid ${color};` : ''}">
        ${overridden ? '<span class="ovr-mark">调</span>' : ''}
        <span class="c-sub">${filled ? esc(cell.subject) : '<span style="color:#c3c7d6">＋</span>'}</span>
        ${cell.type ? `<span class="c-type" style="color:${color}">${esc(cell.type)}</span>` : ''}
        ${cell.week ? `<span class="wk-badge">${cell.week === 'odd' ? '单周' : '双周'}</span>` : ''}
        ${filled && (cell.teacher || cell.room) ? `<span class="c-meta">${esc([cell.teacher, cell.room].filter(Boolean).join(' · '))}</span>` : ''}
      </div></td>`;
    }).join('');
    return `<tr><td><div class="tt-head-cell"><div class="p-name">${esc(p.name)}</div><div class="p-time">${p.start}–${p.end}</div></div></td>${tds}</tr>`;
  }).join('');

  const swaps = S.state.records.filter(r => r.module === 'swap').slice(0, 6);
  const swapList = swaps.map(r => {
    const d2 = r.data;
    return `<div class="today-row"><span class="t-time">${esc(d2.date || '')}</span>
      <span class="t-name">${esc(d2.orig || '')} → ${esc(d2.now || '')}</span>
      <span class="t-class">${esc(d2.clazz || '')} · <b class="${d2.notice === '已通知到位' ? 'ok-t' : 'warn-t'}">${esc(d2.notice || '')}</b></span></div>`;
  }).join('');

  return `
    <div class="card zc-jw"><h3>🗓️ 聚合周课表<span class="right">
      <button class="btn sm" id="wkPrev">← 上周</button>
      <span class="week-badge">第 ${weekNo} 教学周${isThisWeek ? '（本周）' : ''}</span>
      <button class="btn sm" id="wkNext">下周 →</button>
      ${isThisWeek ? '' : '<button class="btn sm primary" id="wkBack">回到本周</button>'}
    </span></h3>
      <div class="legend-row">${legend}<span class="hint" style="margin-left:auto">点格子编辑 · 可设「单周/双周」上课 · 可选「仅本周」临调</span></div>
      <div class="tt-wrap"><table class="tt">${header}${bodyRows}</table></div>
      <p class="hint">⏰ 节次名称与时间段：在「设置与隐私 → 时间节点」中自由修改 · 🔄 课表保存后日程自动同步（无需手动操作）</p>
    </div>
    <div class="card zc-jw"><h3>🔁 调课记录<span class="right"><button class="btn sm primary" id="swapAddBtn">＋ 新增调课</button></span></h3>
      ${swapList || '<div class="empty" style="padding:14px 0">暂无调课记录</div>'}
    </div>`;
}

function openCellModal(day, pi) {
  const wk = mondayOf(S.weekOffset);
  const merged = mergedTimetable(wk);
  const { cell, overridden } = merged[day][pi];
  const rawBase = merged[day][pi].raw || emptyCell();
  const isAlt = !!(rawBase.alt && cell && rawBase.alt.subject && cell.subject === rawBase.alt.subject && cell.week === rawBase.alt.week);
  const p = S.state.config.periods[pi];
  const types = S.state.config.courseTypes || [];
  openModal(`<h2>${esc(day)} · ${esc(p.name)}（${p.start}–${p.end}）<button class="m-close" data-close>✕</button></h2>
    <form id="cellForm">
      <div class="field"><label>课程名称</label><input type="text" id="cSubject" value="${esc(cell.subject)}" placeholder="如：心理健康课"></div>
      <div class="row2">
        <div class="field"><label>课程类型（色调区分）</label><select id="cType">
          <option value="">未分类</option>
          ${types.map(t => `<option value="${esc(t.name)}"${cell.type === t.name ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>教师 / 备注</label><input type="text" id="cTeacher" value="${esc(cell.teacher || '')}"></div>
      </div>
      <div class="field"><label>班级 / 地点</label><input type="text" id="cRoom" value="${esc(cell.room || '')}"></div>
      <div class="row2">
        <div class="field"><label>上课周次</label><select id="cWeek">
          <option value=""${!cell.week ? ' selected' : ''}>每周</option>
          <option value="odd"${cell.week === 'odd' ? ' selected' : ''}>单周（第1/3/5…教学周）</option>
          <option value="even"${cell.week === 'even' ? ' selected' : ''}>双周（第2/4/6…教学周）</option>
        </select></div>
        <div class="field"><label>开始时间（选填，日程用）</label><input type="text" inputmode="numeric" autocomplete="off" id="cTime" value="${esc(cell.time || '')}" placeholder="${esc(p.start)}（只填数字自动补 0）"></div>
      </div>
      ${cell.alt ? `<p class="hint">🔁 该格为单双周交替：另一周是「${esc(cell.alt.subject || '')}」（在课表与日程中自动按周切换）</p>` : ''}
      <div class="field"><label>修改范围</label>
        <label class="radio-line"><input type="radio" name="cScope" value="base" ${overridden ? '' : 'checked'}> 学期固定课表</label>
        <label class="radio-line"><input type="radio" name="cScope" value="week" ${overridden ? 'checked' : ''}> 仅本周（当周调课）</label>
      </div>
      <div class="m-foot">
        <button type="button" class="btn danger" id="cDel">删除课程</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`);
  $('#cellForm').addEventListener('submit', async e => {
    e.preventDefault();
    const wkSel = ($('#cWeek') && $('#cWeek').value) || '';
    const val = {
      subject: $('#cSubject').value.trim(),
      type: $('#cType').value,
      teacher: $('#cTeacher').value.trim(),
      room: $('#cRoom').value.trim(),
      week: wkSel
    };
    const tval = normalizeTime(($('#cTime') && $('#cTime').value) || '');
    if (tval) val.time = tval;
    const checked = $$('input[name=cScope]').filter(r => r.checked)[0];
    const scope = checked ? checked.value : 'base';
    try {
      if (scope === 'week') {
        const res = await api('PUT', '/api/timetable/override', { week: wk, day, period: pi, cell: val });
        bumpLocal(res.version);
      } else {
        if (overridden) {
          await api('PUT', '/api/timetable/override', { week: wk, day, period: pi, cell: null });
        }
        const tt = JSON.parse(JSON.stringify(S.state.timetable));
        if (!tt[day]) tt[day] = {};
        if (isAlt && rawBase.alt) {
          tt[day][String(pi)] = Object.assign({}, rawBase, { alt: Object.assign({}, rawBase.alt, val) });
        } else {
          const keepAlt = rawBase.alt && val.week && rawBase.alt.week !== val.week ? rawBase.alt : null;
          tt[day][String(pi)] = keepAlt ? Object.assign({}, val, { alt: keepAlt }) : val;
        }
        const res = await api('PUT', '/api/timetable', { timetable: tt });
        bumpLocal(res.version);
      }
      await loadState();
      closeModal();
      rerender();
      toast('课表已保存 ✓');
    } catch (e2) { toast(e2.message); }
  });
  $('#cDel').addEventListener('click', async () => {
    if (!confirm('删除该格课程？')) return;
    try {
      if (overridden) {
        const res = await api('PUT', '/api/timetable/override', { week: wk, day, period: pi, cell: null });
        bumpLocal(res.version);
      } else {
        const tt = JSON.parse(JSON.stringify(S.state.timetable));
        tt[day][String(pi)] = { subject: '', type: '', teacher: '', room: '' };
        const res = await api('PUT', '/api/timetable', { timetable: tt });
        bumpLocal(res.version);
      }
      await loadState();
      closeModal();
      rerender();
      toast('已删除');
    } catch (e2) { toast(e2.message); }
  });
}

/* ================= 通用记录模块（列表） ================= */
function moduleOf(key) { return S.state.config.modules.find(m => m.key === key); }
function recordsOf(key) { return S.state.records.filter(r => r.module === key); }

function recTitle(m, r) {
  const t = m.fields.find(f => (f.type === 'text' || f.type === 'url') && r.data[f.key]);
  return (t && r.data[t.key]) || (r.data.content ? String(r.data.content).slice(0, 26) : '') || '未命名记录';
}

function fileChip(fid) {
  const f = (S.state.files || []).find(x => x.id === fid);
  if (!f) return '';
  if (STATIC) {
    if (f.pub) return `<a class="file-chip md-view" href="" data-mdview="${f.id}" onclick="return false">📖 ${esc(f.name)}</a>`;
    return `<span class="file-chip file-locked">🔒 ${esc(f.name)}（未公开）</span>`;
  }
  // Markdown 教学设计：点击页面内预览，无需下载
  if (/\.md$/i.test(f.name || '') || /markdown|text\/plain/.test(f.mime || '')) {
    return `<a class="file-chip md-view" href="" data-mdview="${f.id}" onclick="return false">📖 ${esc(f.name)}</a>`;
  }
  return `<a class="file-chip" href="/api/files/${f.id}?t=${encodeURIComponent(TOKEN)}" download="${esc(f.name)}">📎 ${esc(f.name)}</a>`;
}

// OneNote/Word 导出的 md 常把一句话硬折成多段，这里把「没说完」的段落缝合回一段
function flowify(text) {
  const src = String(text || '').replace(/<!--[\s\S]*?-->/g, '');
  const pieces = [];
  for (const b of src.split(/\n\s*\n/)) {
    b.trim();
    if (!b.trim()) continue;
    // 【…】标记前一定另起一段
    b.replace(/\s+$/g, '').split(/(?=【)/).forEach(s => { s = s.trim(); if (s) pieces.push(s); });
  }
  const isSpecial = s => /^(#{1,6}\s|[-*+]\s|\d+[.、]\s|&gt;|>|```|---)/.test(s);
  const out = [];
  for (const b of pieces) {
    const prev = out[out.length - 1];
    const openEnded = prev && !isSpecial(prev) && !/[。！？!?：；…」』”）)\]]\s*$/.test(prev);
    const marked = prev && /【/.test(prev);
    if (openEnded && !marked && !isSpecial(b) && !/^【/.test(b)) out[out.length - 1] = prev + b;
    else out.push(b);
  }
  return out.join('\n\n');
}

async function openMdPreview(fid) {
  const f = (S.state.files || []).find(x => x.id === fid) || {};
  try {
    const res = await fetch(STATIC ? ('files/' + fid + '.md') : ('/api/files/' + fid + '?t=' + encodeURIComponent(TOKEN)));
    if (!res.ok) throw new Error('读取失败 ' + res.status);
    const text = await res.text();
    openModal(`<h2>📖 ${esc(f.name || '教学设计')}<button class="m-close" data-close>✕</button></h2>
      <div class="doc-meta-bar">教学设计 · ${text.length} 字 · 点击文件名即可在此预览，无需下载</div>
      <div class="doc-render">${mdToHtml(flowify(text))}</div>
      <div class="m-foot">
        <button type="button" class="btn" data-close>关闭</button>
        <a class="btn" href="${STATIC ? 'files/' + fid + '.md' : '/api/files/' + fid + '?t=' + encodeURIComponent(TOKEN)}" download="${esc(f.name || '')}">⬇️ 下载原文件</a>
      </div>`, 'doc-wide');
  } catch (e) { toast('预览失败：' + e.message); }
}

function urlBtn(v) {
  const u = String(v);
  const safe = /^https?:\/\//i.test(u) ? u : 'https://' + u;
  return `<a class="url-chip" href="${esc(safe)}" target="_blank" rel="noopener">🔗 打开链接</a>`;
}

/* ================= 个人经历（按年份分组的履历视图） ================= */
function expYearOf(r) {
  const m = String(r.data.date || '').match(/((?:19|20)\d{2})/);
  return m ? m[1] : '更早';
}

function viewExp(m) {
  const all = recordsOf('exp');
  const cats = [...new Set(all.map(r => r.data.cat).filter(Boolean))];
  let recs = all;
  if (S.expCat) recs = recs.filter(r => r.data.cat === S.expCat);
  if (S.search) {
    const q = S.search.toLowerCase();
    const ks = ['date', 'cat', 'org', 'title', 'note'];
    recs = recs.filter(r => ks.some(k => String(r.data[k] || '').toLowerCase().includes(q)));
  }
  const groups = {};
  for (const r of recs) {
    const y = expYearOf(r);
    (groups[y] = groups[y] || []).push(r);
  }
  const years = Object.keys(groups).sort((a, b) => String(b).localeCompare(String(a)));
  const chips = [`<button class="exp-chip${S.expCat ? '' : ' active'}" data-expcat="">全部 <b>${all.length}</b></button>`]
    .concat(cats.map(c => {
      const n = all.filter(r => r.data.cat === c).length;
      return `<button class="exp-chip${S.expCat === c ? ' active' : ''}" data-expcat="${esc(c)}">${esc(c)} <b>${n}</b></button>`;
    })).join('');
  const rows = years.map(y => `
    <div class="exp-group">
      <div class="exp-year">${esc(y)}<span>${groups[y].length} 条</span></div>
      ${groups[y].map(r => `<div class="exp-row">
        <span class="ex-date">${esc(r.data.date || '')}</span>
        <span class="ex-cat">${esc(r.data.cat || '')}</span>
        <span class="ex-main">${esc(r.data.title || '')}${r.data.org ? `<i>${esc(r.data.org)}</i>` : ''}${r.data.note ? `<em>${esc(r.data.note)}</em>` : ''}</span>
        <span class="ex-act"><button data-rec-edit="${r.id}">编辑</button><button data-rec-del="${r.id}">删除</button></span>
      </div>`).join('')}
    </div>`).join('');
  return `
    <div class="rec-toolbar exp-tools">
      <input id="recSearch" placeholder="搜索经历 / 机构 / 内容…" value="${esc(S.search)}">
      <button class="btn primary" id="recAddBtn">＋ 新增</button>
    </div>
    <div class="exp-chips">${chips}</div>
    <div class="exp-list">${rows || '<div class="empty"><div class="e-ic">🪪</div>暂无经历记录</div>'}</div>`;
}

/* ================= 个案辅导记录（按班级分组 · 查看全文） ================= */
function viewCase(m) {
  let recs = recordsOf('case');
  if (S.search) {
    const q = S.search.toLowerCase();
    const ks = ['code', 'clazz', 'date', 'entry', 'assess', 'topic', 'process'];
    recs = recs.filter(r => ks.some(k => String(r.data[k] || '').toLowerCase().includes(q)));
  }
  const rank = c => {
    const t = String(c || '');
    const g = { '六': 1, '七': 2, '八': 3, '九': 4 };
    const h = { '高一': 5, '高二': 6, '高三': 7 };
    let base = 9, num = 0;
    for (const k in h) if (t.startsWith(k)) base = h[k];
    if (base === 9) for (const k in g) if (t.startsWith(k)) base = g[k];
    const m = t.match(/(\d+)\s*班/);
    num = m ? parseInt(m[1], 10) : 0;
    return base * 100 + num;
  };
  recs = recs.slice().sort((a, b) =>
    rank(a.data.clazz) - rank(b.data.clazz) ||
    String(b.data.date || '').localeCompare(String(a.data.date || '')));
  const groups = {};
  for (const r of recs) {
    const c = r.data.clazz || '未分班';
    (groups[c] = groups[c] || []).push(r);
  }
  const keys = Object.keys(groups).sort((a, b) => rank(a) - rank(b));
  const rows = keys.map(c => `
    <div class="exp-group">
      <div class="exp-year">${esc(c)}<span>${groups[c].length} 人</span></div>
      ${groups[c].map(r => `<div class="exp-row">
        <span class="ex-date">${esc(r.data.date || '')}</span>
        <span class="ex-cat">${esc(r.data.code || '')}</span>
        <span class="ex-main">${esc(r.data.topic || '（待补主诉）')}${r.data.entry ? `<i>来源：${esc(r.data.entry)}</i>` : ''}${r.data.assess ? `<em>评估：${esc(r.data.assess)}</em>` : ''}</span>
        <span class="ex-act"><button data-case-view="${r.id}">查看全文</button><button data-rec-edit="${r.id}">编辑</button></span>
      </div>`).join('')}
    </div>`).join('');
  return `
    <div class="rec-toolbar exp-tools">
      <input id="recSearch" placeholder="搜索代称 / 班级 / 议题…" value="${esc(S.search)}">
      <button class="btn primary" id="recAddBtn">＋ 新增个案</button>
    </div>
    <p class="hint">🔒 隐私红线区 · 严禁外传 · 记录总数 ${recs.length}</p>
    <div class="exp-list">${rows || '<div class="empty"><div class="e-ic">🗂</div>暂无个案档案</div>'}</div>`;
}

function openCaseView(r) {
  const d = r.data;
  const paras = String(d.process || '').split('\n').filter(x => x.trim())
    .map(x => `<p>${esc(x)}</p>`).join('');
  const head = `<div class="cv-head"><b>${esc(d.clazz || '')} · ${esc(d.code || '')}</b>
    <span>${esc(d.date || '')}${d.entry ? ' · 来源：' + esc(d.entry) : ''}${d.assess ? ' · 评估：' + esc(d.assess) : ''}</span></div>`;
  const topic = d.topic ? `<div class="cv-topic"><b>主诉议题</b>${esc(d.topic)}</div>` : '';
  const follow = d.follow ? `<div class="cv-topic"><b>后续计划</b>${esc(d.follow)}</div>` : '';
  openModal(`<div class="m-head-row"><b>🗂 个案跟进时间线</b><button class="m-close" data-close>✕</button></div>
    ${head}${topic}
    <div class="cv-body">${paras || '<p class="hint">暂无跟进记录</p>'}</div>${follow}`, 'doc-wide');
}

/* ================= 教案：原地放大 / 修订 / 导入 ================= */
// 收集教案正文：note 字段 + Markdown 附件文本（合并展示）
async function lessonBodyText(r) {
  const d = r.data || {};
  let text = String(d.note || '');
  const mdFiles = (d.files || []).map(id => (S.state.files || []).find(f => f.id === id))
    .filter(f => f && (/\.(md|markdown)$/i.test(f.name || '') || /markdown|text\/plain/.test(f.mime || '')));
  for (const f of mdFiles) {
    try {
      const res = await fetch(STATIC ? ('files/' + f.id + '.md') : ('/api/files/' + f.id + '?t=' + encodeURIComponent(TOKEN)));
      if (res.ok) {
        const t = await res.text();
        if (t && t.trim()) text += (text ? '\n\n' : '') + '> 附件：' + f.name + '\n\n' + t;
      }
    } catch (e) { /* 单个附件读取失败不影响其余 */ }
  }
  return text;
}

async function openLessonView(r) {
  const d = r.data || {};
  const body = await lessonBodyText(r);
  const files = (d.files || []).map(fileChip).join('');
  const linked = recordsOf('track').filter(t => t.data.lessonId === r.id)
    .sort((a, b) => String(b.data.date || '').localeCompare(String(a.data.date || '')));
  const tracksHtml = linked.length ? `<div class="lesson-track">
    <div class="lt-head"><b>📝 关联课堂记录</b><span class="lt-count">${linked.length} 条</span></div>
    ${linked.map(t => `<div class="lt-item" data-track-view="${t.id}" data-track-from-lesson="1" style="cursor:pointer">
      <span class="lt-date">${formatDateCN(t.data.date) || ''}${t.data.clazz ? ' · ' + esc(t.data.clazz) : ''}</span>
      <span class="lt-text">${esc(String(t.data.situation || '').slice(0, 100))}</span></div>`).join('')}
  </div>` : '';
  const meta = [d.type, d.link ? `<a class="url-chip" href="${esc(/^https?:\/\//i.test(d.link) ? d.link : 'https://' + d.link)}" target="_blank" rel="noopener">🔗 相关链接</a>` : '']
    .filter(Boolean).join(' · ');
  openModal(`<div class="m-head-row"><b>📖 ${esc(d.title || '教学设计')}</b><button class="m-close" data-close>✕</button></div>
    ${meta ? `<div class="doc-meta-bar">${meta} · ${body.length} 字</div>` : `<div class="doc-meta-bar">${body.length} 字</div>`}
    <div class="doc-render">${mdToHtml(flowify(body)) || '<p class="hint">（这份教案还没有正文，点下方「修订正文」开始写）</p>'}</div>
    ${files ? `<div class="r-files" style="margin-top:12px">${files}</div>` : ''}
    ${tracksHtml}
    <div class="m-foot">
      <button type="button" class="btn" data-close>关闭</button>
      ${STATIC ? '' : `<button type="button" class="btn primary" data-lesson-revise="${r.id}">✏️ 修订正文</button>`}
    </div>`, 'doc-wide');
}

function openLessonEditor(r) {
  const d = r.data || {};
  openModal(`<h2>✏️ 修订 · ${esc(d.title || '教学设计')}<span class="doc-save-state" id="lessonSaveState"></span><button class="m-close" data-close>✕</button></h2>
    <div class="field" style="margin-bottom:10px"><label>标题</label><input type="text" id="lessonTitle" value="${esc(d.title || '')}"></div>
    <textarea id="lessonBody" class="doc-editor" placeholder="用 Markdown 写教学设计：
# 课题
- 目标 / 重难点 / 流程
**活动**：说明…">${esc(d.note || '')}</textarea>
    <div id="lessonPreview" class="doc-render" hidden></div>
    <div class="doc-tools">
      <button type="button" class="btn sm" id="lessonToggle">👁 预览</button>
      <span class="hint" id="lessonWords"></span>
      <button type="button" class="btn primary sm" id="lessonSave">保存</button>
    </div>`, 'doc-wide');
  const ta = $('#lessonBody');
  const words = () => { const el = $('#lessonWords'); if (el) el.textContent = ta.value.length + ' 字'; };
  words();
  let timer = null;
  const save = async silent => {
    try {
      const data = Object.assign({}, r.data, { title: $('#lessonTitle').value.trim() || r.data.title, note: ta.value });
      const res = await api('PUT', '/api/records/' + r.id, { data });
      Object.assign(r.data, data);
      await loadState();
      const st = $('#lessonSaveState');
      if (st) { st.textContent = silent ? '已自动保存 ✓' : '已保存 ✓'; setTimeout(() => { const s2 = $('#lessonSaveState'); if (s2) s2.textContent = ''; }, 1800); }
      if (!silent) { closeModal(); rerender(); }
    } catch (err) { toast('保存失败：' + err.message); }
  };
  ta.addEventListener('input', () => {
    words();
    const st = $('#lessonSaveState'); if (st) st.textContent = '编辑中…';
    clearTimeout(timer); timer = setTimeout(() => save(true), 2000);
  });
  ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); clearTimeout(timer); save(false); } });
  $('#lessonSave').addEventListener('click', () => { clearTimeout(timer); save(false); });
  $('#lessonToggle').addEventListener('click', () => {
    const pv = $('#lessonPreview');
    if (pv.hidden) { pv.innerHTML = mdToHtml(flowify(ta.value)) || '<p class="hint">（空）</p>'; pv.hidden = false; ta.hidden = true; $('#lessonToggle').textContent = '✏️ 编辑'; }
    else { pv.hidden = true; ta.hidden = false; $('#lessonToggle').textContent = '👁 预览'; ta.focus(); }
  });
}

function openLessonImport() {
  openModal(`<h2>📥 导入教学设计<button class="m-close" data-close>✕</button></h2>
    <p class="hint" style="margin:4px 0 12px">选择 Markdown / 文本文件，自动读取内容生成一份教案；标题取文件名，正文可继续修订。</p>
    <input type="file" id="lessonImportFile" accept=".md,.markdown,.txt,text/markdown,text/plain" class="file-input">
    <div id="lessonImportPreview" class="doc-render" style="max-height:260px;overflow:auto;margin-top:10px" hidden></div>
    <div class="m-foot"><button type="button" class="btn" data-close>取消</button>
      <button type="button" class="btn primary" id="lessonImportSave" disabled>导入为教案</button></div>`, 'doc-wide');
  const input = $('#lessonImportFile');
  let loaded = null;
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('文件超过 5MB，请拆分后再导入'); return; }
    const text = await f.text();
    loaded = { name: f.name.replace(/\.(md|markdown|txt)$/i, ''), text };
    const pv = $('#lessonImportPreview');
    pv.innerHTML = `<div class="doc-meta-bar">${f.name} · ${text.length} 字</div><div class="doc-render">${mdToHtml(flowify(text.slice(0, 4000)))}</div>`;
    pv.hidden = false;
    $('#lessonImportSave').disabled = false;
  });
  $('#lessonImportSave').addEventListener('click', async () => {
    if (!loaded) return;
    const btn = $('#lessonImportSave'); btn.disabled = true; btn.textContent = '导入中…';
    try {
      const data = { title: loaded.name, type: '教案', note: loaded.text, link: '', files: [] };
      await api('POST', '/api/records', { module: 'lesson', data });
      await loadState();
      closeModal(); rerender(); toast('已导入为教案 ✓ 点标题可查看全文');
    } catch (err) { toast('导入失败：' + err.message); btn.disabled = false; btn.textContent = '导入为教案'; }
  });
}

function viewModule(m) {
  let recs = recordsOf(m.key);
  if (S.search) {
    const q = S.search.toLowerCase();
    recs = recs.filter(r => Object.values(r.data).some(v => String(v || '').toLowerCase().includes(q)));
  }
  const dateField = m.fields.find(f => f.type === 'date');
  if (dateField) {
    recs = recs.slice().sort((a, b) => String(b.data[dateField.key] || b.createdAt).localeCompare(String(a.data[dateField.key] || a.createdAt)));
  }

  const card = r => {
    const items = m.fields.filter(f => {
      const v = r.data[f.key];
      return v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && f.type !== 'files';
    }).map(f => {
      const isLong = f.type === 'textarea';
      const val = f.type === 'date' ? formatDateCN(r.data[f.key]) : f.type === 'url' ? urlBtn(r.data[f.key]) : esc(r.data[f.key]);
      return `<div class="r-item${isLong || f.type === 'url' ? ' full' : ''}"><b>${esc(f.label)}</b>${val}</div>`;
    }).join('');
    const allFiles = [];
    for (const f of m.fields.filter(x => x.type === 'files')) {
      (r.data[f.key] || []).forEach(id => allFiles.push(id));
    }
    const filesHtml = allFiles.length ? `<div class="r-files">${allFiles.map(fileChip).join('')}</div>` : '';
    const tag = r.data.level === '一级（高危）' ? '<span class="r-tag warn">🚨 高危</span>'
      : r.data.status ? `<span class="r-tag">${esc(r.data.status)}</span>`
      : r.data.notice ? `<span class="r-tag${r.data.notice === '已通知到位' ? '' : ' warn'}">${esc(r.data.notice)}</span>` : '';
    const isLesson = m.key === 'lesson';
    let trackHtml = '';
    if (isLesson) {
      const linked = recordsOf('track')
        .filter(t => t.data.lessonId === r.id)
        .sort((a, b) => String(b.data.date || '').localeCompare(String(a.data.date || '')));
      trackHtml = `
        <div class="lesson-track">
          <div class="lt-head">
            <b>📝 课堂记录</b><span class="lt-count">${linked.length ? linked.length + ' 条' : '还没有'}</span>
            <button type="button" class="btn sm primary lt-add" data-track-add="${r.id}">＋ 课堂记录</button>
          </div>
          ${linked.length ? linked.map(t => `<div class="lt-item" data-track-view="${t.id}" style="cursor:pointer">
            <span class="lt-date">${formatDateCN(t.data.date) || ''}${t.data.clazz ? ' · ' + esc(t.data.clazz) : ''}</span>
            <span class="lt-text">${esc(String(t.data.situation || '').slice(0, 80))}${String(t.data.situation || '').length > 80 ? '…' : ''}</span>
            <button type="button" class="lt-edit" data-rec-edit="${t.id}">编辑</button>
          </div>`).join('') : ''}
        </div>`;
    }
    const titleHtml = isLesson
      ? `<span class="r-title lesson-open" data-lesson-view="${r.id}" title="点击查看教案全文">${esc(recTitle(m, r))} <span class="lesson-open-ic">⤢</span></span>`
      : `<span class="r-title">${esc(recTitle(m, r))}</span>`;
    const lessonActions = isLesson ? `<button data-lesson-revise="${r.id}">✏️ 修订正文</button>` : '';
    return `<div class="rec-card">
      <div class="r-head">${titleHtml}${tag}</div>
      <div class="r-grid">${items}</div>
      ${filesHtml}
      ${trackHtml}
      <div class="r-actions">
        ${lessonActions}
        <button data-rec-edit="${r.id}">编辑</button>
        <button data-rec-del="${r.id}">删除</button>
      </div>
    </div>`;
  };

  const resTools = m.key === 'resource' ? `
      <button class="btn" id="importLinkBtn">🔗 链接导入</button>
      <button class="btn" id="fetchRssBtn">⚡ 抓取订阅源</button>` : '';
  const lessonTools = m.key === 'lesson' ? `<button class="btn" id="lessonImportBtn">📥 导入教学设计</button>` : '';
  return `
    <div class="rec-toolbar">
      <input id="recSearch" placeholder="搜索…" value="${esc(S.search)}">
      ${resTools}${lessonTools}
      <button class="btn primary" id="recAddBtn">＋ 新增</button>
    </div>
    ${m.key === 'resource' ? '<p class="hint">🌐 小红书/公众号无开放API：用「链接导入」收藏公众号文章，或在设置里配置 RSS 订阅源（每日 8 点自动抓取）。</p>' : ''}
    ${recs.length ? recs.map(card).join('') : '<div class="empty"><div class="e-ic">' + esc(m.icon || '📁') + '</div>暂无记录，点右上「新增」创建</div>'}`;
}

/* ================= 学生名册（按班级呈现） ================= */
function viewRosterByClass(m) {
  let recs = recordsOf('roster');
  if (S.search) {
    const q = S.search.toLowerCase();
    recs = recs.filter(r => Object.values(r.data).some(v => String(v || '').toLowerCase().includes(q)));
  }
  const groups = {};
  recs.forEach(r => {
    const c = String(r.data.clazz || '').trim() || '未分班';
    (groups[c] = groups[c] || []).push(r);
  });
  const classes = Object.keys(groups).sort((a, b) => clazzRank(a) - clazzRank(b) || a.localeCompare(b, 'zh'));
  if (!classes.includes(S.rosterClass)) S.rosterClass = classes[0] || '';
  const cur = S.rosterClass;
  const list = (groups[cur] || []).slice().sort((a, b) => String(a.data.sid || '').localeCompare(String(b.data.sid || '')));
  return `
    <div class="rec-toolbar">
      <input id="recSearch" placeholder="搜索姓名 / 学号 / 班主任…" value="${esc(S.search)}">
      <span class="roster-stat">共 <b>${recs.length}</b> 人 · <b>${classes.length}</b> 个班级</span>
      <button class="btn primary" id="recAddBtn">＋ 新增学生</button>
    </div>
    <div class="roster-shell">
      <div class="roster-nav">
        <div class="roster-nav-title">班级导航</div>
        ${classes.map(c => `<button class="roster-cls${c === cur ? ' active' : ''}" data-roster-class="${esc(c)}"><span>${esc(c)}</span><em>${groups[c].length}</em></button>`).join('')}
      </div>
      <div class="roster-main">
        <div class="roster-main-head"><b>${esc(cur)}</b><span>${list.length} 人</span></div>
        ${list.length ? `<table class="roster-table">
          <thead><tr><th>学号</th><th>姓名</th><th>性别</th><th>班主任</th><th style="width:110px">操作</th></tr></thead>
          <tbody>${list.map(r => `<tr>
            <td>${esc(r.data.sid || '—')}</td>
            <td class="roster-name">${esc(r.data.name || '')}</td>
            <td>${esc(r.data.gender || '—')}</td>
            <td>${esc(r.data.headteacher || '—')}</td>
            <td><button class="roster-op" data-rec-edit="${r.id}">编辑</button><button class="roster-op danger" data-rec-del="${r.id}">删除</button></td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="empty"><div class="e-ic">👥</div>该班级暂无学生</div>'}
      </div>
    </div>`;
}

/* ================= 脱敏预约登记（周期合并显示） ================= */
function viewAppoint(m) {
  let recs = recordsOf('appoint');
  if (S.search) {
    const q = S.search.toLowerCase();
    recs = recs.filter(r => Object.values(r.data).some(v => String(v || '').toLowerCase().includes(q)));
  }
  // 按分组键聚合：周期组 → 一组；单条 → 各自成组
  const groups = new Map();
  recs.forEach(r => {
    const gk = apGroupKey(r.data) || ('one|' + r.id);
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(r);
  });
  const list = Array.from(groups, ([key, items]) => ({ key, items }))
    .map(g => { g.items.sort((a, b) => String(a.data.date || '').localeCompare(String(b.data.date || ''))); return g; })
    .sort((a, b) => String(b.items[0].data.date || '').localeCompare(String(a.items[0].data.date || '')));

  const groupCard = g => {
    const items = g.items;
    const first = items[0].data;
    const isCycle = items.length > 1 || !!first.apRule;
    const open = S.apOpenGroups && S.apOpenGroups.has(g.key);
    if (!isCycle) {
      const d = first;
      const meta = [d.clazz, d.date ? formatDateCN(d.date) : '', d.time].filter(Boolean).map(esc).join(' · ');
      return `<div class="ap-card single">
        <div class="ap-card-head"><span class="ap-title">${esc(d.code || '未命名')}</span><span class="ap-tag">单次</span></div>
        <div class="ap-meta">${meta || '<span class="hint">暂无日期</span>'} ${d.from ? '<span class="ap-from">' + esc(d.from) + '</span>' : ''} ${d.status ? '<span class="ap-status">' + esc(d.status) + '</span>' : ''}</div>
        <div class="ap-actions"><button data-rec-edit="${items[0].id}">编辑</button><button data-rec-del="${items[0].id}">删除</button></div>
      </div>`;
    }
    const dates = items.map(i => i.data.date).filter(Boolean);
    const span = dates.length ? `${formatDateCN(dates[0])} ~ ${formatDateCN(dates[dates.length - 1])}` : '';
    const rows = items.map(i => {
      const d = i.data;
      return `<div class="ap-sess-row"><span class="ap-sess-date">${d.date ? formatDateCN(d.date) : '未定'}</span>
        <span class="ap-sess-time">${esc(d.time || '')}</span>
        <span class="ap-sess-status">${esc(d.status || '')}</span>
        <span class="ap-sess-ops"><button data-rec-edit="${i.id}">改</button><button data-rec-del="${i.id}">删</button></span></div>`;
    }).join('');
    return `<div class="ap-card cycle">
      <div class="ap-card-head">
        <span class="ap-title">🔁 ${esc(first.code || '未命名')} <span class="ap-count">${items.length} 次</span></span>
        <span class="ap-tag cycle">周期</span>
      </div>
      <div class="ap-meta">${esc(first.clazz || '')} ${first.apRule ? '<span class="ap-rule">' + esc(first.apRule) + '</span>' : ''} <span class="ap-span">${esc(span)}</span> ${first.time ? '· ' + esc(first.time) : ''}</div>
      <div class="ap-actions">
        <button data-apgroup-toggle="${esc(g.key)}">${open ? '收起场次 ▲' : '展开场次 ▼ (' + items.length + ')'}</button>
        <button data-apgroup-edit="${esc(g.key)}">改整个安排</button>
        <button data-apgroup-del="${esc(g.key)}" class="danger">删整组</button>
      </div>
      ${open ? `<div class="ap-sessions">${rows}</div>` : ''}
    </div>`;
  };

  return `
    <div class="rec-toolbar">
      <input id="recSearch" placeholder="搜索代称 / 班级 / 备注…" value="${esc(S.search)}">
      <span class="roster-stat">共 <b>${recs.length}</b> 条预约 · <b>${list.length}</b> 组</span>
      <button class="btn primary" id="recAddBtn">＋ 新增预约</button>
    </div>
    <p class="hint">周期预约已合并为一张卡片：展开可看每次日期、单条改删，或「改整个安排」调整重复规则。</p>
    ${list.length ? list.map(groupCard).join('') : '<div class="empty"><div class="e-ic">🗓</div>暂无预约，点右上「新增预约」创建</div>'}`;
}

/* ================= 学习笔记（在线文档） ================= */
function mdToHtml(src) {
  const lines = esc(String(src || '')).split('\n');
  let out = '', list = null, inCode = false;
  const inline = t => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const closeList = () => { if (list) { out += '</' + list + '>'; list = null; } };
  for (const line of lines) {
    if (/^```/.test(line)) { closeList(); out += inCode ? '</code></pre>' : '<pre><code>'; inCode = !inCode; continue; }
    if (inCode) { out += line + '\n'; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closeList(); out += '<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'; continue; }
    if (/^\s*[-*+]\s+/.test(line)) { if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; } out += '<li>' + inline(line.replace(/^\s*[-*+]\s+/, '')) + '</li>'; continue; }
    if (/^\s*\d+[.、]\s+/.test(line)) { if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; } out += '<li>' + inline(line.replace(/^\s*\d+[.、]\s+/, '')) + '</li>'; continue; }
    if (/^\s*(&gt;|>)\s?/.test(line)) { closeList(); out += '<blockquote>' + inline(line.replace(/^\s*(&gt;|>)\s?/, '')) + '</blockquote>'; continue; }
    if (/^\s*(-{3,}|={3,}|\*{3,})\s*$/.test(line)) { closeList(); out += '<hr>'; continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out += '<p>' + inline(line) + '</p>';
  }
  closeList();
  if (inCode) out += '</code></pre>';
  return out;
}

/* ================= 课堂记录（按课题分组 · 一个班一条） ================= */
function viewTrack(m) {
  let recs = recordsOf('track');
  if (S.search) {
    const q = S.search.toLowerCase();
    recs = recs.filter(r => Object.values(r.data).some(v => String(v || '').toLowerCase().includes(q)));
  }
  const groups = {};
  for (const r of recs) {
    const k = String(r.data.lesson || '').trim() || String(r.data.clazz || '').trim() || '未挂课题';
    (groups[k] = groups[k] || []).push(r);
  }
  const latest = arr => arr.reduce((mx, r) => {
    const d = String(r.data.date || '');
    return d > mx ? d : mx;
  }, '');
  const keys = Object.keys(groups).sort((a, b) => latest(groups[b]).localeCompare(latest(groups[a])));
  const card = k => {
    const list = groups[k].slice().sort((a, b) =>
      String(a.data.date || '').localeCompare(String(b.data.date || '')) ||
      String(a.data.clazz || '').localeCompare(String(b.data.clazz || '')) ||
      String(a.data.situation || '').localeCompare(String(b.data.situation || '')));
    const nClass = new Set(list.map(t => t.data.clazz || '')).size;
    return `<div class="rec-card">
      <div class="r-head"><span class="r-title">${esc(k)}</span><span class="r-tag">${list.length} 条 · ${nClass} 个班</span></div>
      <div class="track-rows">${list.map(t => `<div class="track-row" data-track-view="${t.id}">
          <span class="tr-cls">${esc(t.data.clazz || '未标班级')}</span>
          <span class="tr-date">${formatDateCN(t.data.date) || '无日期'}</span>
          <span class="tr-text">${esc(String(t.data.situation || '').replace(/\s+/g, ' ').slice(0, 70))}${String(t.data.situation || '').length > 70 ? '…' : ''}</span>
          <span class="tr-act">
            <button type="button" data-track-view="${t.id}">查看</button>
            <button type="button" data-rec-edit="${t.id}">编辑</button>
          </span>
        </div>`).join('')}</div>
    </div>`;
  };
  return `<div class="rec-toolbar">
      <input id="recSearch" placeholder="搜索课题、班级或内容…" value="${esc(S.search)}">
      <button class="btn primary" id="recAddBtn">＋ 新增</button>
    </div>
    <p class="hint">📝 按课题分组，每个班一条记录（【1】~【6】= 高一1~6班）；点「查看」读全文</p>
    ${keys.length ? keys.map(card).join('') : '<div class="empty"><div class="e-ic">📝</div>暂无课堂记录</div>'}`;
}

function openTrackView(r) {
  const d = r.data || {};
  const paras = String(d.situation || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
    .map(s => `<p>${esc(s)}</p>`).join('');
  openModal(`<h2>📝 ${esc(d.lesson || '课堂记录')}<button class="m-close" data-close>✕</button></h2>
    <div class="doc-meta-bar">${esc(d.clazz || '未标班级')} · ${formatDateCN(d.date) || '无日期'}</div>
    <div class="doc-render">${paras || '<p class="hint">（暂无内容，点「编辑」补充）</p>'}</div>
    <div class="m-foot">
      <button type="button" class="btn" data-close>关闭</button>
      <button type="button" class="btn primary" data-rec-edit="${r.id}">✏️ 编辑</button>
    </div>`, 'doc-wide');
}

/* ================= 学习笔记（石墨文档式工作台） ================= */
function docSorted(list) {
  const recs = list || recordsOf('trainnote');
  return recs.slice().sort((a, b) =>
    String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}
function docMatch(r) {
  if (!S.search) return true;
  const q = S.search.toLowerCase();
  return Object.values(r.data || {}).some(v => String(v || '').toLowerCase().includes(q));
}
function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时前';
  const day = Math.floor(h / 24);
  if (day < 8) return day + ' 天前';
  return formatDateCN(String(iso).slice(0, 10)) || '';
}
function docRow(r) {
  const d = r.data || {};
  const body = String(d.points || '');
  const plain = body.replace(/[#*`>\-\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return `<button type="button" class="doc-item${r.id === S.docId ? ' active' : ''}" data-doc-select="${r.id}">
      <span class="di-title">${esc(d.topic || '无标题文档')}</span>
      <span class="di-snippet">${esc(plain.slice(0, 44)) || '空白文档'}</span>
      <span class="di-meta">${relTime(r.updatedAt || r.createdAt)}${body ? ' · ' + body.length + ' 字' : ''}</span>
    </button>`;
}
function refreshDocList() {
  const box = document.querySelector('.doc-side-list');
  if (!box) return;
  const recs = docSorted().filter(docMatch);
  box.innerHTML = recs.length ? recs.map(docRow).join('') : '<div class="doc-side-empty">没有匹配的文档</div>';
  const foot = document.querySelector('.doc-side-foot');
  if (foot) foot.textContent = `共 ${recs.length} 篇 · 自动保存`;
}

function viewTrainDocs(m) {
  const all = recordsOf('trainnote');
  if (!all.some(r => r.id === S.docId)) S.docId = STATIC && all.length ? docSorted(all)[0].id : null;
  const recs = docSorted(all).filter(docMatch);
  return `<div class="doc-shell">
    <aside class="doc-side">
      <div class="doc-side-top">
        ${STATIC ? '' : '<button class="btn primary sm" id="docNewBtn" title="新建文档">＋ 新建</button>'}
        <input id="recSearch" class="doc-search" placeholder="搜索标题或正文…" value="${esc(S.search)}">
      </div>
      <div class="doc-side-list">${recs.length ? recs.map(docRow).join('') : '<div class="doc-side-empty">还没有文档</div>'}</div>
      <div class="doc-side-foot">共 ${recs.length} 篇 · 自动保存</div>
    </aside>
    <section class="doc-pane" id="docPane" data-doc=""></section>
  </div>`;
}

function docWelcome() {
  return `<div class="doc-welcome">
      <div class="dw-ic">📄</div>
      <p>把想法写成文档：左侧选择一篇，或${STATIC ? '（只读快照）' : '点「＋ 新建」'}</p>
      <p class="hint">正文支持 Markdown：&#96;# 标题&#96;、&#96;- 列表&#96;、&#96;**加粗**&#96;、&#96;&gt; 引用&#96;、[链接](https://…)</p>
    </div>`;
}

const MD_TOOLS = [
  { k: 'h1', label: 'H1', tip: '一级标题', line: '# ' },
  { k: 'h2', label: 'H2', tip: '二级标题', line: '## ' },
  { k: 'h3', label: 'H3', tip: '三级标题', line: '### ' },
  { k: 'b', label: 'B', tip: '加粗', pre: '**', suf: '**', ph: '加粗' },
  { k: 'i', label: 'I', tip: '斜体', pre: '*', suf: '*', ph: '斜体' },
  { k: 'ul', label: '≡', tip: '无序列表', line: '- ' },
  { k: 'ol', label: '1.', tip: '有序列表', line: '1. ' },
  { k: 'q', label: '❝', tip: '引用', line: '> ' },
  { k: 'code', label: '</>', tip: '代码', pre: '`', suf: '`', ph: '代码' },
  { k: 'link', label: '🔗', tip: '链接', pre: '[', suf: '](https://)', ph: '链接文字' },
  { k: 'hr', label: '—', tip: '分割线', raw: '\n---\n' }
];

function docEditHtml(rec) {
  const d = rec.data || {};
  const body = String(d.points || '');
  const tools = MD_TOOLS.map(t =>
    `<button type="button" class="md-btn" data-md-insert="${t.k}" title="${t.tip}">${t.label}</button>`).join('');
  return `<div class="doc-bar">
      <input id="docTitle" class="doc-title-input" value="${esc(d.topic || '')}" placeholder="无标题文档">
      <span class="doc-state" id="docState"></span>
      <span class="doc-words" id="docWords">${body.length} 字</span>
      <button type="button" class="btn sm" id="docPreviewBtn">👁 预览</button>
    </div>
    <div class="doc-tools-row">${tools}</div>
    <div class="doc-body">
      <textarea id="docBody" class="doc-textarea" spellcheck="false"
        placeholder="# 标题
- 要点一
- 要点二

**加粗**、&#96;代码&#96;、[链接](https://…)">${esc(body)}</textarea>
      <div id="docPreview" class="doc-render doc-preview" hidden></div>
      <aside class="doc-outline" id="docOutline"></aside>
    </div>
    ${(d.files || []).length ? `<div class="doc-files">${(d.files || []).map(fileChip).join('')}</div>` : ''}
    <div class="doc-foot">
      <span>${formatDateCN(d.date) || '无日期'}${d.from ? ' · ' + esc(d.from) : ''}</span>
      <span class="hint">停止输入即自动保存 · Ctrl/⌘+S 立即保存</span>
    </div>`;
}

function docReadHtml(rec) {
  const d = rec.data || {};
  return `<div class="doc-bar">
      <input class="doc-title-input" value="${esc(d.topic || '无标题文档')}" readonly>
      <span class="doc-words">${String(d.points || '').length} 字</span>
    </div>
    <div class="doc-body">
      <div class="doc-render doc-preview">${mdToHtml(d.points) || '<p class="hint">（空白文档）</p>'}</div>
      <aside class="doc-outline" id="docOutline"></aside>
    </div>
    ${(d.files || []).length ? `<div class="doc-files">${(d.files || []).map(fileChip).join('')}</div>` : ''}
    <div class="doc-foot"><span>${formatDateCN(d.date) || '无日期'}${d.from ? ' · ' + esc(d.from) : ''}</span><span class="hint">只读快照</span></div>`;
}

function paintOutline(text) {
  const box = $('#docOutline');
  if (!box) return;
  const heads = String(text || '').split('\n').map(l => {
    const m = l.match(/^(#{1,3})\s+(.*)$/);
    return m ? { lv: m[1].length, text: m[2].trim() } : null;
  }).filter(Boolean);
  box.innerHTML = heads.length
    ? `<div class="do-title">大纲</div>` + heads.map(h =>
      `<button type="button" class="do-item lv${h.lv}" data-outline="${esc(h.text)}">${esc(h.text)}</button>`).join('')
    : '';
}

async function mountDocPane(force) {
  const pane = $('#docPane');
  if (!pane) return;
  const id = String(S.docId || '');
  const cur = pane.getAttribute('data-doc') || '';
  if (!force && cur === id && pane.innerHTML.trim()) return;
  S.docDirty = false;
  clearTimeout(S.docTimer);
  pane.setAttribute('data-doc', id);
  const rec = recordsOf('trainnote').find(r => r.id === id);
  if (!rec) { pane.innerHTML = docWelcome(); pane.setAttribute('data-doc', ''); return; }
  pane.innerHTML = STATIC ? docReadHtml(rec) : docEditHtml(rec);
  if (!STATIC) bindDocEditor(rec);
  paintOutline(rec.data && rec.data.points);
}

async function flushDoc() {
  if (S.docDirty && typeof S.docSave === 'function') {
    try { await S.docSave(true); } catch (e) {}
  }
  S.docDirty = false;
}

async function selectDoc(id) {
  if (S.docId === id) return;
  await flushDoc();
  S.docId = id;
  document.querySelectorAll('.doc-item').forEach(b => b.classList.toggle('active', b.getAttribute('data-doc-select') === id));
  await mountDocPane(true);
}

function bindDocEditor(rec) {
  const ta = $('#docBody'), title = $('#docTitle');
  if (!ta) return;
  const setState = txt => { const el = $('#docState'); if (el) el.textContent = txt; };
  const collect = () => {
    const data = Object.assign({}, rec.data, { topic: title.value.trim(), points: ta.value });
    if (!data.date) data.date = todayStr();
    return data;
  };
  const save = async silent => {
    clearTimeout(S.docTimer);
    try {
      setState('保存中…');
      const data = collect();
      await api('PUT', '/api/records/' + rec.id, { data });
      rec.data = data;
      S.docDirty = false;
      refreshDocList();
      setState(silent ? '已自动保存 ✓' : '已保存 ✓');
      setTimeout(() => { if (!S.docDirty) setState(''); }, 1600);
    } catch (err) {
      setState('保存失败');
      toast('保存失败：' + err.message);
    }
  };
  S.docSave = save;
  const onChange = () => {
    S.docDirty = true;
    setState('编辑中…');
    const w = $('#docWords');
    if (w) w.textContent = ta.value.length + ' 字';
    paintOutline(ta.value);
    clearTimeout(S.docTimer);
    S.docTimer = setTimeout(() => save(true), 1200);
  };
  ta.addEventListener('input', onChange);
  title.addEventListener('input', onChange);
  ta.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); }
  });
  $('#docPreviewBtn').addEventListener('click', () => {
    const pv = $('#docPreview');
    if (pv.hidden) {
      pv.innerHTML = mdToHtml(ta.value) || '<p class="hint">（空文档）</p>';
      pv.hidden = false; ta.hidden = true;
      $('#docPreviewBtn').textContent = '✏️ 编辑';
      if (pv.scrollTop === 0) pv.scrollTop = 0;
    } else {
      pv.hidden = true; ta.hidden = false;
      $('#docPreviewBtn').textContent = '👁 预览';
      ta.focus();
    }
  });
  document.querySelectorAll('[data-md-insert]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = MD_TOOLS.find(x => x.k === btn.getAttribute('data-md-insert'));
      if (!t) return;
      const s = ta.selectionStart, e2 = ta.selectionEnd;
      const cur = ta.value;
      if (t.raw) {
        ta.value = cur.slice(0, e2) + t.raw + cur.slice(e2);
        ta.selectionStart = ta.selectionEnd = e2 + t.raw.length;
      } else if (t.line) {
        const lineStart = cur.lastIndexOf('\n', s - 1) + 1;
        ta.value = cur.slice(0, lineStart) + t.line + cur.slice(lineStart);
        ta.selectionStart = ta.selectionEnd = s + t.line.length;
      } else {
        const sel = cur.slice(s, e2) || t.ph || '';
        ta.value = cur.slice(0, s) + t.pre + sel + t.suf + cur.slice(e2);
        ta.selectionStart = s + t.pre.length;
        ta.selectionEnd = s + t.pre.length + sel.length;
      }
      ta.focus();
      onChange();
    });
  });
  document.querySelectorAll('[data-outline]').forEach(b => {
    b.addEventListener('click', () => {
      const txt = b.getAttribute('data-outline');
      const lines = ta.value.split('\n');
      const idx = lines.findIndex(l => /^#{1,3}\s+/.test(l) && l.replace(/^#{1,3}\s+/, '').trim() === txt);
      if (idx < 0) return;
      const pos = lines.slice(0, idx).join('\n').length + (idx ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(pos, pos);
      // 粗略滚动到该行
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22;
      ta.scrollTop = Math.max(0, (idx - 2) * lh);
    });
  });
  setTimeout(() => ta.focus(), 40);
}

async function newDoc() {
  const data = { topic: '', points: '', date: todayStr() };
  const res = await api('POST', '/api/records', { module: 'trainnote', data });
  await flushDoc();
  await loadState();
  S.docId = res.record.id;
  S.search = '';
  rerender();
  mountDocPane(true);
  const t = $('#docTitle');
  if (t) t.focus();
}

function openDocView(rec) {
  const d = rec.data || {};
  const files = (d.files || []).map(fileChip).join('');
  openModal(`<h2>📄 ${esc(d.topic || '未命名文档')}<button class="m-close" data-close>✕</button></h2>
    <div class="doc-meta-bar">${formatDateCN(d.date) || '无日期'}${d.from ? ' · ' + esc(d.from) : ''} · ${String(d.points || '').length} 字</div>
    <div class="doc-render">${mdToHtml(d.points) || '<p class="hint">（空文档，点「编辑」开始写）</p>'}</div>
    ${files ? `<div class="r-files" style="margin-top:12px">${files}</div>` : ''}
    <div class="m-foot">
      <button type="button" class="btn" data-close>关闭</button>
      <button type="button" class="btn primary" data-doc-edit="${rec.id}">✏️ 编辑</button>
    </div>`, 'doc-wide');
}

function openDocEditor(rec) {
  const d = rec.data || {};
  let dirty = false, timer = null;
  openModal(`<h2>✏️ ${esc(d.topic || '未命名文档')}<span class="doc-save-state" id="docSaveState"></span><button class="m-close" data-close>✕</button></h2>
    <textarea id="docText" class="doc-editor" placeholder="用 Markdown 写笔记：
# 一级标题
- 要点列表
**加粗**、\`代码\`、[链接](https://…)">${esc(d.points || '')}</textarea>
    <div id="docPreview" class="doc-render" hidden></div>
    <div class="doc-tools">
      <button type="button" class="btn sm" id="docToggle">👁 预览</button>
      <span class="hint" id="docWords"></span>
      <button type="button" class="btn primary sm" id="docSave">保存</button>
    </div>`, 'doc-wide');
  const ta = $('#docText');
  const words = () => { const el = $('#docWords'); if (el) el.textContent = ta.value.length + ' 字'; };
  words();
  const save = async silent => {
    try {
      const data = Object.assign({}, rec.data, { points: ta.value });
      const res = await api('PUT', '/api/records/' + rec.id, { data });
      rec.data = data;
      dirty = false;
      await loadState();
      if (!silent) rerender();
      const st = $('#docSaveState');
      if (st) { st.textContent = silent ? '已自动保存 ✓' : '已保存 ✓'; setTimeout(() => { const s2 = $('#docSaveState'); if (s2) s2.textContent = ''; }, 1800); }
    } catch (err) {
      const st = $('#docSaveState');
      if (st) st.textContent = '保存失败';
      toast('保存失败：' + err.message);
    }
  };
  ta.addEventListener('input', () => {
    dirty = true;
    words();
    const st = $('#docSaveState');
    if (st) st.textContent = '编辑中…';
    clearTimeout(timer);
    timer = setTimeout(() => { if (dirty && ta.value !== rec.data.points) save(true); }, 2000);
  });
  ta.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); clearTimeout(timer); save(false); }
  });
  $('#docSave').addEventListener('click', () => { clearTimeout(timer); save(false); });
  $('#docToggle').addEventListener('click', () => {
    const pv = $('#docPreview');
    if (pv.hidden) {
      pv.innerHTML = mdToHtml(ta.value) || '<p class="hint">（空）</p>';
      pv.hidden = false; ta.hidden = true;
      $('#docToggle').textContent = '✏️ 编辑';
    } else {
      pv.hidden = true; ta.hidden = false;
      $('#docToggle').textContent = '👁 预览';
      ta.focus();
    }
  });
  $('#modalBox .m-close').addEventListener('click', () => {
    if (dirty && ta.value !== rec.data.points) { clearTimeout(timer); save(true); }
  });
  setTimeout(() => ta.focus(), 60);
}

/* ================= 看板视图 ================= */
function viewKanban(m) {
  let recs = recordsOf(m.key);
  const gf = m.groupField;
  const gField = m.fields.find(f => f.key === gf);
  const opts = (gField && gField.options) || ['未分类'];

  const card = r => {
    const due = r.data.due || r.data.date;
    const du = due ? daysUntil(due) : null;
    const urgent = du !== null && du <= 1 && du >= -30;
    return `<div class="kb-card">
      <div class="kb-title">${esc(recTitle(m, r))}</div>
      ${m.fields.filter(f => !['textarea', 'files', 'text'].includes(f.type) && f.key !== gf && r.data[f.key])
        .map(f => `<div class="kb-meta">${esc(f.label)}：${f.type === 'date' ? formatDateCN(r.data[f.key]) : f.type === 'url' ? urlBtn(r.data[f.key]) : esc(r.data[f.key])}</div>`).join('')}
      ${du !== null ? `<div class="kb-due${urgent ? ' overdue' : ''}">⏰ ${du > 0 ? `剩 ${du} 天` : du === 0 ? '今天' : `已过 ${-du} 天`}</div>` : ''}
      <div class="kb-move">
        <select data-kanban-move="${r.id}">
          ${opts.map(o => `<option value="${esc(o)}"${r.data[gf] === o ? ' selected' : ''}>→ ${esc(o)}</option>`).join('')}
        </select>
        <button data-rec-edit="${r.id}">编辑</button>
        <button data-rec-del="${r.id}">删</button>
      </div>
    </div>`;
  };

  const cols = opts.map(o => {
    const list = recs.filter(r => (r.data[gf] || '') === o);
    return `<div class="kb-col">
      <div class="kb-col-head">${esc(o)} <span class="kb-count">${list.length}</span></div>
      ${list.map(card).join('') || '<div class="kb-empty">空</div>'}
    </div>`;
  }).join('');

  return `
    <div class="rec-toolbar">
      <input id="recSearch" placeholder="搜索…" value="${esc(S.search)}">
      <button class="btn primary" id="recAddBtn">＋ 新增</button>
    </div>
    <div class="kanban">${cols}</div>`;
}

/* ================= 首页 · 月历（苹果日历风格） ================= */
function collectCalEvents() {
  const st = S.state;
  const map = {};
  const push = (date, item) => { if (!date) return; (map[date] = map[date] || []).push(item); };
  for (const r of st.records) {
    const d = r.data || {};
    if (r.module === 'calevent' && d.date) push(d.date, { color: catColor(d.cat), label: d.cat || '日程', title: d.title, time: d.time, id: r.id });
    else if (r.module === 'appoint' && d.date) push(d.date, { color: catColor('个案'), label: '个案', title: '🔒 预约 ' + (d.code || ''), time: d.time });
    else if (r.module === 'interview' && d.date) push(d.date, { color: catColor('个案'), label: '个案', title: '🔒 访谈 ' + (d.code || ''), time: d.time });
    else if (r.module === 'swap' && d.date) push(d.date, { color: '#7A8699', label: '调课', title: (d.orig || '') + ' → ' + (d.now || ''), time: '' });
    else if (r.module === 'career' && d.date) push(d.date, { color: catColor('导师'), label: '导师', title: d.title, time: d.time });
    else if (r.module === 'genderedu' && d.date) push(d.date, { color: catColor('凿光'), label: '凿光', title: d.title, time: d.time });
  }
  for (const t of st.todos) if (t.due && !t.done) push(t.due, { color: '#E8A33D', label: '待办', title: t.text, time: '' });
  for (const h of (st.config.holidays || [])) if (h.date) push(h.date, { color: '#B08BE8', label: '假期', title: h.name, time: '' });
  return map;
}

function viewMonthCalendar() {
  const now = new Date();
  const y = S.calYear || now.getFullYear();
  const m = S.calMonth || (now.getMonth() + 1);
  const today = todayStr();
  const events = collectCalEvents();

  const first = new Date(y, m - 1, 1);
  const startDow = first.getDay(); // 0 = 周日（苹果日历中文样式）
  const daysInMonth = new Date(y, m, 0).getDate();
  const daysPrevMonth = new Date(y, m - 1, 0).getDate();

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const dayNum = i - startDow + 1;
    let dateStr, inMonth = true, dnum;
    if (dayNum < 1) { inMonth = false; dnum = daysPrevMonth + dayNum; dateStr = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-${String(dnum).padStart(2, '0')}`; }
    else if (dayNum > daysInMonth) { inMonth = false; dnum = dayNum - daysInMonth; dateStr = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-${String(dnum).padStart(2, '0')}`; }
    else { dnum = dayNum; dateStr = `${y}-${String(m).padStart(2, '0')}-${String(dnum).padStart(2, '0')}`; }
    const evs = events[dateStr] || [];
    const isToday = dateStr === today;
    const dots = evs.slice(0, 3).map(ev => `<span class="cal-dot" style="background:${ev.color}"></span>`).join('')
      + (evs.length > 3 ? `<span class="cal-more">+${evs.length - 3}</span>` : '');
    cells += `<button class="cal-cell${isToday ? ' today' : ''}${inMonth ? '' : ' dim'}" data-cal-day="${dateStr}">
      <span class="cal-d">${dnum}</span><span class="cal-dots">${dots}</span></button>`;
  }

  // 图例直接来自 CAL_CATS，和「新增日程」的类型选项永远一致
  const legend = CAL_CATS.map(c =>
    `<span class="legend-item"><span class="type-dot" style="background:${c[1]}"></span>${esc(c[0])}</span>`).join('');

  return `
    <div class="cal-nav">
      <button class="btn sm" data-cal-nav="-1">←</button>
      <b>${y}年${m}月</b>
      <button class="btn sm" data-cal-nav="1">→</button>
      <button class="btn sm" data-cal-today="1">今天</button>
      <button class="btn sm primary" id="calAddEvent">＋ 新增日程</button>
      <button class="btn sm" data-tt-sync="1" title="按最新课表重新展开日程（幂等，不会重复）">🔄 同步课表</button>
      <button class="btn sm" id="calNoticeImport" title="粘贴通知，自动解析成日程">📥 通知导入</button>
    </div>
    <div class="cal-grid">
      <div class="cal-wk">日</div><div class="cal-wk">一</div><div class="cal-wk">二</div><div class="cal-wk">三</div><div class="cal-wk">四</div><div class="cal-wk">五</div><div class="cal-wk">六</div>
      ${cells}
    </div>
    <div class="legend-row" style="margin-top:10px">${legend}
      <span class="hint" style="margin-left:auto">🍏 可在设置中与苹果日历订阅/导入同步</span>
    </div>`;
}

/* ================= 图片灯箱（缩略图点开放大） ================= */
function openLightbox(imgId) {
  const files = S.state.files || [];
  const isImg = id => { const f = files.find(x => x.id === id); return f && /^image\//.test(f.mime); };
  // 同一条记录里的所有图片为一组，可左右切换
  let ids = [imgId];
  for (const r of S.state.records) {
    const arr = r.data && r.data.files;
    if (Array.isArray(arr) && arr.includes(imgId)) { ids = arr.filter(isImg); break; }
  }
  if (!ids.length) ids = [imgId];
  let i = Math.max(0, ids.indexOf(imgId));

  const box = document.createElement('div');
  box.className = 'img-lightbox';
  const draw = () => {
    const id = ids[i];
    const f = files.find(x => x.id === id) || {};
    const src = '/api/files/' + id + '?t=' + encodeURIComponent(TOKEN);
    box.innerHTML = `
      <div class="lb-stage"><img src="${src}" alt=""></div>
      ${ids.length > 1 ? `<button class="lb-nav prev" data-lb="-1">‹</button><button class="lb-nav next" data-lb="1">›</button>` : ''}
      <div class="lb-bar">
        <span class="lb-count">${i + 1} / ${ids.length}</span>
        <span class="lb-name">${esc(f.name || '')}</span>
        <a class="lb-dl" href="${src}" download="${esc(f.name || 'image')}">下载</a>
        <button class="lb-close" data-lb-close>✕</button>
      </div>`;
  };
  draw();
  box.addEventListener('click', e => {
    if (e.target.closest('[data-lb-close]') || e.target.classList.contains('lb-stage') || e.target === box) { box.remove(); document.removeEventListener('keydown', onKey); return; }
    const nav = e.target.closest('[data-lb]');
    if (nav) { i = (i + parseInt(nav.getAttribute('data-lb'), 10) + ids.length) % ids.length; draw(); }
  });
  const onKey = e => {
    if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'ArrowLeft' && ids.length > 1) { i = (i - 1 + ids.length) % ids.length; draw(); }
    if (e.key === 'ArrowRight' && ids.length > 1) { i = (i + 1) % ids.length; draw(); }
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
}

/* ================= 通知 → 日程（智能解析） ================= */
const WD_IDX = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function shiftDate(base, n) { return dstr(new Date(base.getTime() + n * 864e5)); }
function pad2(n) { return String(n).padStart(2, '0'); }

function extractDates(chunk) {
  const today = new Date(todayStr() + 'T00:00:00');
  const out = [];
  let m;
  // 1) 2026-11-20 / 2026年11月20日
  const re1 = /(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})\s*日?/g;
  while ((m = re1.exec(chunk))) out.push(m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]));
  if (out.length) return out;
  const mk = (mo, da) => {
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    let d = new Date(today.getFullYear(), mo - 1, da);
    if (d < new Date(today.getTime() - 30 * 864e5)) d = new Date(today.getFullYear() + 1, mo - 1, da);
    return dstr(d);
  };
  // 2) 11月20日 / 11月20号
  const re2 = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
  while ((m = re2.exec(chunk))) { const v = mk(+m[1], +m[2]); if (v) out.push(v); }
  if (out.length) return out;
  // 3) 11/20 或 11-20
  const re3 = /(\d{1,2})\s*[\/\-]\s*(\d{1,2})/g;
  while ((m = re3.exec(chunk))) {
    const before = chunk[m.index - 1] || '', after = chunk[m.index + m[0].length] || '';
    if (/\d/.test(before) || /\d/.test(after)) continue;
    const v = mk(+m[1], +m[2]); if (v) out.push(v);
  }
  if (out.length) return out;
  // 4) 今天 / 明天 / 后天
  const rel = chunk.match(/(大后天|后天|明天|明日|今天|今日)/);
  if (rel) return [shiftDate(today, { '今天': 0, '今日': 0, '明天': 1, '明日': 1, '后天': 2, '大后天': 3 }[rel[1]])];
  // 5) 本周五 / 下周三 / 星期三
  const re5 = /(下下|下|本|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g;
  const monday = new Date(mondayOf(0) + 'T00:00:00');
  while ((m = re5.exec(chunk))) {
    const off = WD_IDX[m[2]] === 0 ? 6 : WD_IDX[m[2]] - 1;
    let base = monday;
    if (m[1] === '下') base = new Date(monday.getTime() + 7 * 864e5);
    if (m[1] === '下下') base = new Date(monday.getTime() + 14 * 864e5);
    let cand = new Date(base.getTime() + off * 864e5);
    if (!m[1] && cand < today) cand = new Date(cand.getTime() + 7 * 864e5); // 只说“周五”且已过 → 下周
    out.push(dstr(cand));
  }
  return out;
}

function extractTime(chunk) {
  let m = chunk.match(/(上午|早上|早晨|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (!m) m = chunk.match(/(上午|早上|早晨|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[点時时]\s*(半|\d{1,2}\s*分?)?/);
  if (!m) return '';
  let h = +m[2];
  const mi = m[3] === '半' ? 30 : (parseInt(m[3], 10) || 0);
  const pfx = m[1] || '';
  if (/下午|傍晚|晚上/.test(pfx) && h < 12) h += 12;
  if (/中午/.test(pfx) && h < 11) h += 12;
  return pad2(Math.min(23, h)) + ':' + pad2(Math.min(59, mi));
}

function cleanTitle(chunk) {
  let t = chunk;
  t = t.replace(/\d{4}\s*[-\/年.]\s*\d{1,2}\s*[-\/月.]\s*\d{1,2}\s*日?/g, ' ');
  t = t.replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, ' ');
  t = t.replace(/\d{1,2}\s*[\/\-]\s*\d{1,2}/g, ' ');
  t = t.replace(/(下下|下|本|这)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]/g, ' ');
  t = t.replace(/(大后天|后天|明天|明日|今天|今日)/g, ' ');
  t = t.replace(/(上午|早上|早晨|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*[:：]\s*\d{1,2}/g, ' ');
  t = t.replace(/(上午|早上|早晨|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*[点時时]\s*(半|\d{1,2}\s*分?)?/g, ' ');
  t = t.replace(/[，,]?\s*(?:地点|地址|会场|会议地点|地点为)\s*[:：]?\s*[^\s，,。；;、]+/g, ' ');
  t = t.replace(/在[^\s，,。；;]{2,15}?(?:举行|召开|开展|进行)/g, ' ');
  t = t.replace(/(请准时参加|请准时出席|准时参加|望周知|请知悉|请相互转告|特此通知)/g, ' ');
  t = t.replace(/^(关于|通知|提醒|请注意|请|于|定于|安排|举行|召开|我校|全校)[\s:：，,]*/g, '');
  t = t.replace(/^[，,、;；:：\-\s]+/, '').replace(/[，,、;；:：\-\s]+$/, '');
  t = t.replace(/[（(]\s*[）)]/g, '').replace(/\s{2,}/g, ' ').trim();
  const firstClause = t.split(/[，,]/)[0].trim();
  if (firstClause.length >= 4) t = firstClause;
  // 「关于召开××大会的通知：」这类公文抬头反复剥壳
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^(关于|请|特此|现将|有关)?\s*(召开|举行|组织|举办|开展)?\s*/g, '');
    t = t.replace(/(的?通知|告知书|函)\s*[:：]?\s*$/g, '');
    t = t.replace(/^[:：，,、\s]+|[:：，,、\s]+$/g, '');
    if (t === before) break;
  }
  return t ? t.slice(0, 60) : '';
}

function parseNotice(raw) {
  const text = String(raw || '').replace(/\u3000/g, ' ');
  const lines = text.split(/[\n\r;；。]+/).map(t => t.trim()).filter(Boolean);
  const items = [];
  const seen = {};
  for (const line of lines) {
    const dates = extractDates(line);
    if (!dates.length) continue;
    const time = extractTime(line);
    const title = cleanTitle(line) || '日程';
    const cat = guessCat(title) || '日程';
    const loc = (line.match(/(?:地点|地址|会场|会议室|报告厅|在)\s*[:：]?\s*([^\s，,。；;、]{2,20})/) || [])[1] || '';
    for (const d of dates) {
      const key = d + '|' + time + '|' + title;
      if (seen[key]) continue;
      seen[key] = 1;
      items.push({ date: d, time, title, cat, note: '📥 来自通知：' + line.slice(0, 200) + (loc ? '\n地点：' + loc : '') });
    }
  }
  return items.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

function noticeCatOptions() {
  const m = moduleOf('calevent');
  const f = m && m.fields.find(x => x.key === 'cat');
  return (f && f.options) || CAL_CATS.map(c => c[0]);
}

function renderNoticePreview(items) {
  S.noticeItems = items;
  const box = $('#noticePreview');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="empty" style="padding:12px 0"><div class="e-ic">🤔</div>没认出日期。试试「11月25日」「本周五」「明天」这类写法，或手动新增</div>';
    return;
  }
  const cats = noticeCatOptions();
  box.innerHTML = `<div class="np-head">识别到 <b>${items.length}</b> 条 · 可改后再存</div>
    <div class="np-list">${items.map((it, i) => `
      <div class="np-row" data-np-row="${i}">
        <input type="checkbox" checked data-np-check>
        <input type="date" data-np-date value="${esc(it.date)}">
        <input type="text" inputmode="numeric" data-np-time data-time="1" value="${esc(it.time)}" placeholder="时间">
        <select data-np-cat>${cats.map(c => `<option value="${esc(c)}"${c === it.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <input type="text" data-np-title value="${esc(it.title)}">
      </div>`).join('')}</div>`;
  $$('#noticePreview [data-time]').forEach(inp => {
    inp.addEventListener('blur', () => { const n = normalizeTime(inp.value); if (n !== inp.value.trim()) inp.value = n; });
  });
}

function openNoticeImport(preset) {
  openModal(`<h2>📥 通知一键转日程<button class="m-close" data-close>✕</button></h2>
    <div class="field"><label>把通知原文粘进来（一段可含多条）</label>
      <textarea id="noticeText" rows="6" placeholder="例：
本周五下午 3:30 教工大会，地点报告厅
11月25日 13:10 高一5 心理课
12/2 上午9:00 教研活动">${esc(preset || '')}</textarea>
      <p class="hint">能认：11月20日 / 2026-11-20 / 11/20 / 今天·明天·后天 / 本周五·下周三；时间 15:30、下午3点半、9点</p>
    </div>
    <div id="noticePreview"></div>
    <div class="m-foot">
      <button type="button" class="btn" data-close>取消</button>
      <button type="button" class="btn" id="noticeParse">🔍 解析</button>
      <button type="button" class="btn primary" id="noticeSave" disabled>全部加入日程</button>
    </div>`);
  const doParse = () => {
    const items = parseNotice($('#noticeText').value);
    renderNoticePreview(items);
    $('#noticeSave').disabled = !items.length;
    if (!items.length) toast('没认出日期，可以写「11月25日」这样的格式');
  };
  $('#noticeParse').addEventListener('click', doParse);
  $('#noticeText').addEventListener('blur', () => { if (!$('#noticePreview').innerHTML) doParse(); });
  $('#noticeSave').addEventListener('click', saveNoticeItems);
  if (preset) doParse();
}

async function saveNoticeItems() {
  const rows = $$('#noticePreview .np-row');
  if (!rows.length) return;
  let ok = 0;
  try {
    for (const row of rows) {
      if (!row.querySelector('[data-np-check]').checked) continue;
      const data = {
        date: row.querySelector('[data-np-date]').value,
        time: normalizeTime(row.querySelector('[data-np-time]').value),
        cat: row.querySelector('[data-np-cat]').value,
        title: row.querySelector('[data-np-title]').value.trim() || '日程',
        note: (S.noticeItems[row.getAttribute('data-np-row')] || {}).note || ''
      };
      if (!data.date) continue;
      await api('POST', '/api/records', { module: 'calevent', data });
      ok++;
    }
    await loadState();
    closeModal();
    rerender();
    toast(`已加入 ${ok} 条日程 ✓`);
  } catch (err) { toast('保存失败：' + err.message); }
}

function openDayModal(dateStr) {
  const st = S.state;
  const evs = collectCalEvents()[dateStr] || [];
  evs.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  const periods = st.config.periods || [];

  const rows = evs.length ? evs.map(ev => {
    const rec = ev.id ? st.records.find(r => r.id === ev.id) : null;
    const movable = !!(rec && rec.data && 'time' in rec.data);
    return `<div class="today-row ev-row${movable ? ' draggable' : ''}"${movable ? ` draggable="true" data-ev-id="${ev.id}"` : ''}>
      <span class="t-time">${ev.time ? esc(ev.time) : '全天'}</span>
      <span class="t-name"><span class="type-dot" style="background:${ev.color}"></span>${esc(ev.title || ev.label)}</span>
      <span class="t-class">${esc(ev.label)}</span>
      <span class="ev-acts">
        ${movable ? `<button type="button" class="cal-act" data-ev-edit="${ev.id}" data-cal-date="${dateStr}" title="编辑时间/内容">✏️</button>` : ''}
        ${ev.id ? `<button type="button" class="cal-act cal-del" data-cal-del="${ev.id}" data-cal-date="${dateStr}" title="删除此日程">🗑</button>` : ''}
      </span>
    </div>`;
  }).join('') : '<div class="empty"><div class="e-ic">🍃</div>这一天没有安排</div>';

  const slots = periods.map(p =>
    `<button type="button" class="slot-chip" data-drop-time="${esc(p.start)}">${esc(p.start)}<small>${esc(p.name)}</small></button>`).join('');

  openModal(`<h2>${formatDateCN(dateStr)}<button class="m-close" data-close>✕</button></h2>
    <div class="ev-list" data-cal-date="${dateStr}">${rows}</div>
    <div class="drop-zone">
      <div class="dz-title">⏱ 拖动上方日程到时间段即可改时间（只改这一天；课表自动生成的日程会记住你的调整）</div>
      <div class="slot-row">${slots}<button type="button" class="slot-chip" data-drop-time="">全天<small>取消时间</small></button></div>
    </div>
    <div class="m-foot">
      <button type="button" class="btn" data-close>关闭</button>
      <button type="button" class="btn primary" id="dayAddEventBtn">＋ 新增日程</button>
    </div>`);

  $('#dayAddEventBtn').addEventListener('click', () => {
    recordForm(moduleOf('calevent'), null, { date: dateStr });
  });

  $$('#modalBox .ev-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      S.dragEvId = row.getAttribute('data-ev-id');
      row.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', S.dragEvId); } catch (_) {}
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); });
  });
  $$('#modalBox [data-drop-time]').forEach(chip => {
    chip.addEventListener('dragover', e => { e.preventDefault(); chip.classList.add('over'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('over'));
    chip.addEventListener('drop', async e => {
      e.preventDefault();
      chip.classList.remove('over');
      let id = S.dragEvId;
      try { id = id || e.dataTransfer.getData('text/plain'); } catch (_) {}
      if (!id) return;
      await setEventTime(id, chip.getAttribute('data-drop-time'), dateStr);
    });
  });
}

// 拖动改时间：课表生成的日程会打标记，重新同步课表时保留手动时间
async function setEventTime(id, time, dateStr) {
  const rec = S.state.records.find(r => r.id === id);
  if (!rec) return;
  const data = Object.assign({}, rec.data, { time: time || '' });
  if (rec.data && rec.data.src === 'timetable') data.timeFixed = true;
  try {
    const res = await api('PUT', '/api/records/' + id, { data });
    bumpLocal(res.version);
    await loadState();
    rerender();
    if (dateStr) openDayModal(dateStr); else closeModal();
    toast(time ? '时间已改为 ' + time + ' ✓' : '已改为全天');
  } catch (err) { toast('修改失败：' + err.message); }
}

/* ================= 其它工作 · 工作日报 ================= */
function viewDailyReport() {
  const st = S.state;
  const today = todayStr();
  const doneTodos = st.todos.filter(t => t.done && (t.doneAt || '').slice(0, 10) === today);
  const newRecs = st.records.filter(r => (r.createdAt || '').slice(0, 10) === today);
  const byMod = {};
  newRecs.forEach(r => { byMod[r.module] = (byMod[r.module] || 0) + 1; });
  const recSummary = Object.keys(byMod).map(k => {
    const m = moduleOf(k);
    return `${m ? m.name : k} ${byMod[k]} 条`;
  }).join('、') || '无';
  const dailyRecs = st.records.filter(r => r.module === 'daily' && r.data.date === today);
  const modName = k => { const m = moduleOf(k); return m ? m.name : k; };
  const modCount = k => st.records.filter(r => r.module === k).length;

  const reportText = `【工作日报】${formatDateCN(today)}
一、完成待办（${doneTodos.length} 项）
${doneTodos.map(t => '  · ' + t.text).join('\n') || '  · 无'}
二、今日新增记录：${recSummary}
三、其它工作留痕（${dailyRecs.length} 条）
${dailyRecs.map(r => '  · [' + (r.data.cat || '') + '] ' + (r.data.content || '')).join('\n') || '  · 无'}`;

  return `
    <div class="card zc-pv"><h3>📋 今日工作日报<span class="right">${formatDateCN(today)}</span></h3>
      <div class="r-grid">
        <div class="r-item"><b>完成待办</b>${doneTodos.length} 项</div>
        <div class="r-item"><b>新增记录</b>${recSummary}</div>
        <div class="r-item"><b>留痕条目</b>${dailyRecs.length} 条</div>
        <div class="r-item"><b>累计</b>闪念 ${modCount('flash')} · 留痕 ${modCount('daily')}</div>
      </div>
      <textarea id="reportText" class="report-box" readonly>${esc(reportText)}</textarea>
      <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
        <button class="btn sm primary" id="reportCopyBtn">📋 复制日报</button>
        <button class="btn sm" id="dailyAddBtn">＋ 补充其它工作留痕</button>
      </div>
      <p class="hint">日报由系统自动汇总今日完成待办、新增记录与留痕；补充记录区用于其它工作留痕。</p>
    </div>
    <div class="card zc-pv"><h3>🧾 留痕记录（今日）</h3>
      ${dailyRecs.length ? dailyRecs.map(r => `<div class="today-row"><span class="t-time">${esc(r.data.cat || '')}</span><span class="t-name">${esc(r.data.content || '')}</span></div>`).join('') : '<div class="empty" style="padding:14px 0">今天还没有留痕</div>'}
    </div>`;
}

/* ================= 其它工作 · 闪念笔记 ================= */
function viewFlash(m) {
  const recs = recordsOf(m.key);
  return `
    <div class="card zc-sw"><h3>⚡ 灵感捕获 · 闪念笔记</h3>
      <textarea id="flashText" placeholder="随时随地记录工作感悟、教学灵感…（Ctrl/⌘+Enter 保存）" style="width:100%;min-height:90px"></textarea>
      <div style="display:flex;gap:10px;margin-top:10px;align-items:center;flex-wrap:wrap">
        <select id="flashTag"><option value="工作感悟">工作感悟</option><option value="教学灵感">教学灵感</option><option value="生活随记">生活随记</option><option value="待研究">待研究</option></select>
        <button class="btn primary sm" id="flashSaveBtn">⚡ 保存闪念</button>
        <span class="hint" style="margin-left:auto">共 ${recs.length} 条</span>
      </div>
    </div>
    ${recs.length ? recs.map(r => `<div class="rec-card" style="border-left-color:var(--c-an)">
      <div class="r-head"><span class="r-tag">${esc(r.data.tag || '')}</span><span class="r-title" style="font-weight:400;white-space:normal">${esc(r.data.content || '')}</span></div>
      <div class="r-actions"><button data-rec-edit="${r.id}">编辑</button><button data-rec-del="${r.id}">删除</button></div>
    </div>`).join('') : '<div class="empty"><div class="e-ic">⚡</div>第一条闪念，从现在开始</div>'}`;
}

/* ================= 自我关怀 · 疗愈金句 ================= */
const QUOTES = [
  { t: '你不需要等到"足够好"才开始照顾自己。', s: '自我关怀' },
  { t: '情绪没有好坏，它们只是信使。', s: '情绪疗愈' },
  { t: '允许自己是一支普通的铅笔，也允许今天只写一行字。', s: '减压' },
  { t: '深呼吸是随身携带的镇静剂。', s: '放松' },
  { t: '课题分离：别人如何评价你，是别人的课题。', s: '阿德勒' },
  { t: '你可以在水深火热的同时，好好吃饭。', s: '生活' },
  { t: '成长不是变成别人，而是更接近自己。', s: '成长' },
  { t: '疲惫不是软弱，是身体在诚实地说话。', s: '身心' },
  { t: '每一次呼吸，都是重新开始的机会。', s: '正念' },
  { t: '你已经 survived 了 100% 的糟糕日子。', s: '韧性' },
  { t: '不必今日事今日毕，但可以今日事今日始。', s: '行动' },
  { t: '照顾好那个上课的你，也照顾好下班后的你。', s: '教师关怀' },
  { t: '界限不是冷漠，是对关系的尊重。', s: '界限' },
  { t: '眼泪是身体替你说出的语言。', s: '情绪' },
  { t: '慢慢来，比较快。', s: '节奏' },
  { t: '你不必背负整个世界，你只需要过好今天。', s: '当下' },
  { t: '自我批评只会让人瘫软，自我关怀让人站起来。', s: 'Kristin Neff' },
  { t: '承认"我需要帮助"，本身就是一种能力。', s: '求助' },
  { t: '今天的你，已经比昨天的你多懂了一点点。', s: '成长' },
  { t: '休息不是偷懒，是蓄能。', s: '休息' },
  { t: '那些杀死不了你的，会让你学会新的应对方式。', s: '韧性' },
  { t: '把"我必须"换成"我选择"，感觉会完全不同。', s: '认知' },
  { t: '焦虑常常是对未来的想象力用错了地方。', s: '焦虑' },
  { t: '一个人的价值不由产出决定。', s: '自我价值' },
  { t: '你不需要点亮整个房间，照亮自己的角落就够了。', s: '自我关怀' },
  { t: '感受可以被命名，被命名的情绪就开始安分。', s: '情绪命名' },
  { t: '善待自己，像善待你最好的朋友那样。', s: '自我关怀' },
  { t: '完美主义是焦虑穿的正装。', s: '完美主义' },
  { t: '孩子的行为是一封写信给你的信，先读信，再回信。', s: '儿童心理' },
  { t: '倾听时不急着解决，陪伴本身就是干预。', s: '咨询' },
  { t: '教室里的安全感，比教学技巧更早发生作用。', s: '教育' },
  { t: '你无法从空杯子里倒出水来，先给自己续杯。', s: '能量管理' },
  { t: '关系是心理工作的药，也是心理工作的耗损，记得平衡。', s: '职业' },
  { t: '允许今天只做三件事，做慢一点。', s: '减压' },
  { t: '身体先安顿，心才跟得上。', s: '身心' },
  { t: '看见学生的资源，比看见问题更有力量。', s: '焦点解决' },
  { t: '每一朵乌云都镶着银边，但先允许乌云存在。', s: '接纳' },
  { t: '和情绪坐一会儿，不急着赶它走。', s: '正念' },
  { t: '职业倦怠不是你的错，是系统在报警。', s: '职业' },
  { t: '今天也要像对待学生那样，温柔地对待自己。', s: '自我关怀' }
];

function viewQuotes() {
  const st = S.state;
  const dayIdx = Math.floor(Date.now() / 864e5) % QUOTES.length;
  const idx = S.quoteIdx === undefined ? dayIdx : S.quoteIdx;
  const q = QUOTES[idx];
  const isDaily = S.quoteIdx === undefined;
  return `
    <div class="card zc-sw" style="text-align:center;padding:34px 20px">
      <div class="quote-mark">"</div>
      <div class="quote-text">${esc(q.t)}</div>
      <div class="quote-src">—— ${esc(q.s)} ${isDaily ? '· 今日金句' : ''}</div>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap">
        <button class="btn primary" id="quoteAnother">🔄 换一句</button>
        <button class="btn" id="quoteCopy">📋 复制</button>
      </div>
      <p class="hint">每天打开都会随机推送一条心理学疗愈金句 · 共 ${QUOTES.length} 条内置语录</p>
    </div>`;
}

/* ================= 自我关怀 · 放松工具箱 ================= */
function viewRelax() {
  const audios = (S.state.config.relaxAudio || []);
  return `
    <div class="card zc-sw"><h3>🫁 呼吸放松（4-4-4-4 方块呼吸）</h3>
      <div class="breath-wrap">
        <div class="breath-circle" id="breathCircle"><span id="breathText">准备</span></div>
        <div class="breath-count" id="breathCount">--</div>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:14px">
        <button class="btn primary" id="breathStart">▶ 开始</button>
        <button class="btn" id="breathStop">■ 停止</button>
      </div>
      <p class="hint" style="text-align:center">跟随圆圈：吸气 → 屏息 → 呼气 → 屏息，各 4 秒</p>
    </div>
    <div class="card zc-sw"><h3>🌫️ 白噪音 · 助眠/专注</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" data-noise="white">📻 白噪音</button>
        <button class="btn" data-noise="pink">🌧️ 细雨声</button>
        <button class="btn" data-noise="brown">🌊 深海声</button>
        <button class="btn danger" id="noiseStop">■ 停止</button>
      </div>
      <div class="set-row" style="margin-top:12px"><span class="s-label2">音量</span>
        <input type="range" id="noiseVol" min="0" max="1" step="0.05" value="0.4" style="flex:1"></div>
      <p class="hint">由浏览器实时合成，不依赖网络，可长时间播放</p>
    </div>
    <div class="card zc-sw"><h3>🎵 我的冥想音频</h3>
      <input type="file" id="relaxAudioInput" accept="audio/*" style="margin-bottom:10px">
      ${audios.length ? audios.map(id => {
        const f = (S.state.files || []).find(x => x.id === id);
        if (!f) return '';
        return `<div class="audio-item"><div class="audio-name">🎵 ${esc(f.name)}</div>
          <audio controls preload="none" src="/api/files/${f.id}?t=${encodeURIComponent(TOKEN)}"></audio>
          <button class="fe-del" data-audio-del="${f.id}">✕</button></div>`;
      }).join('') : '<div class="empty" style="padding:14px 0">上传正念冥想 / 放松训练音频（MP3 等），随时随地打开疗愈</div>'}
    </div>`;
}

/* ================= 自我关怀 · 安抚银行 ================= */
// 二次门禁：进入安抚银行需再输一道密码（前端门，防误触/随手翻看）
function comfortGateHtml() {
  return `<div class="comfort-gate">
    <div class="cg-icon">🔐</div>
    <div class="cg-title">安抚银行 · 私享空间</div>
    <p class="cg-sub">这里存着你最柔软的时刻。请输入专属口令开启。</p>
    <form id="comfortGateForm" autocomplete="off">
      <input type="password" id="comfortGateInput" placeholder="请输入安抚银行口令" autocomplete="current-password" required>
      <button type="submit" class="btn primary block">开启</button>
      <div class="cg-err" id="comfortGateErr"></div>
    </form>
    <p class="cg-hint">口令仅在本次会话有效，刷新或退出后需重新输入</p>
  </div>`;
}
function viewComfort(m) {
  const recs = recordsOf(m.key).slice().sort((a, b) => String(b.data.date || b.createdAt).localeCompare(String(a.data.date || a.createdAt)));
  const card = r => {
    const imgs = (r.data.files || []).map(id => (S.state.files || []).find(f => f.id === id)).filter(f => f && /^image\//.test(f.mime));
    const others = (r.data.files || []).filter(id => !imgs.some(im => im.id === id));
    return `<div class="comfort-card">
      ${imgs.length ? `<div class="thumb-grid${imgs.length === 1 ? ' single' : ''}">${imgs.map(im =>
        `<button type="button" class="thumb" data-lightbox="${esc(im.id)}" title="${esc(im.name || '查看大图')}">
          <img src="/api/files/${im.id}?t=${encodeURIComponent(TOKEN)}" alt="" loading="lazy">
        </button>`).join('')}</div>` : ''}
      <div class="comfort-body">
        <div class="kb-title">🌤️ ${esc(r.data.title || '积极小事')}</div>
        <div class="kb-meta">${formatDateCN(r.data.date) || ''}</div>
        ${r.data.feeling ? `<div class="kb-meta" style="margin-top:4px">${esc(r.data.feeling)}</div>` : ''}
        ${others.length ? `<div class="r-files">${others.map(fileChip).join('')}</div>` : ''}
        <div class="r-actions"><button data-rec-edit="${r.id}">编辑</button><button data-rec-del="${r.id}">删除</button></div>
      </div>
    </div>`;
  };
  return `
    <div class="rec-toolbar">
      <input id="recSearch" placeholder="搜索…" value="${esc(S.search)}">
      <button class="btn primary" id="recAddBtn">＋ 存入一件温暖小事</button>
    </div>
    <p class="hint">🍯 安抚银行：把生活中记录的积极小事与暖心照片存进来，情绪低落时来"取款"。</p>
    ${recs.length ? `<div class="comfort-grid">${recs.map(card).join('')}</div>` : '<div class="empty"><div class="e-ic">🍯</div>还没有存款，从今天的一件小事开始</div>'}`;
}

/* ================= 放松组件：呼吸 / 白噪音 ================= */
const BREATH_PHASES = [{ t: '吸气', s: 4 }, { t: '屏息', s: 4 }, { t: '呼气', s: 4 }, { t: '屏息', s: 4 }];
function startBreath() {
  if (S.breathTimer) return;
  S.breathIdx = 0; S.breathLeft = BREATH_PHASES[0].s;
  breathTick();
  S.breathTimer = setInterval(breathTick, 1000);
  toast('跟随圆圈呼吸 🫁');
}
function breathTick() {
  const ph = BREATH_PHASES[S.breathIdx];
  const tEl = $('#breathText'), cEl = $('#breathCount'), c = $('#breathCircle');
  if (!tEl) { stopBreath(); return; }
  tEl.textContent = ph.t;
  cEl.textContent = S.breathLeft + 's';
  if (c) {
    if (ph.t === '吸气') c.style.transform = 'scale(1.45)';
    else if (ph.t === '呼气') c.style.transform = 'scale(0.72)';
  }
  S.breathLeft--;
  if (S.breathLeft <= 0) { S.breathIdx = (S.breathIdx + 1) % BREATH_PHASES.length; S.breathLeft = BREATH_PHASES[S.breathIdx].s; }
}
function stopBreath() {
  if (S.breathTimer) { clearInterval(S.breathTimer); S.breathTimer = null; }
  const c = $('#breathCircle');
  if (c) c.style.transform = 'scale(1)';
  const tEl = $('#breathText'), cEl = $('#breathCount');
  if (tEl) tEl.textContent = '准备';
  if (cEl) cEl.textContent = '--';
}

let noiseCtx = null, noiseSrc = null, noiseGain = null;
function startNoise(type) {
  stopNoise();
  try {
    noiseCtx = noiseCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (noiseCtx.state === 'suspended') noiseCtx.resume();
    const rate = noiseCtx.sampleRate, len = 2 * rate;
    const buf = noiseCtx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    if (type === 'white') {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } else if (type === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    noiseSrc = noiseCtx.createBufferSource();
    noiseSrc.buffer = buf; noiseSrc.loop = true;
    noiseGain = noiseCtx.createGain();
    noiseGain.gain.value = parseFloat(($('#noiseVol') || {}).value || 0.4);
    noiseSrc.connect(noiseGain).connect(noiseCtx.destination);
    noiseSrc.start();
    toast({ white: '白噪音播放中 📻', pink: '细雨声播放中 🌧️', brown: '深海声播放中 🌊' }[type] || '播放中');
  } catch (e) { toast('音频初始化失败：' + e.message); }
}
function stopNoise() {
  if (noiseSrc) { try { noiseSrc.stop(); } catch (e) {} noiseSrc = null; }
}

/* ================= 联网资源库：导入与抓取 ================= */
function openImportModal() {
  openModal(`<h2>🔗 链接导入<span class="hint" style="margin-left:10px">粘贴公众号 / 小红书 / 网页链接</span><button class="m-close" data-close>✕</button></h2>
    <form id="importForm">
      <div class="field"><label>文章链接</label><input type="url" id="importUrl" placeholder="https://mp.weixin.qq.com/s/…" required></div>
      <div class="m-foot"><button type="button" class="btn" data-close>取消</button>
      <button type="submit" class="btn primary">抓取并新建资源</button></div>
    </form>`);
  $('#importForm').addEventListener('submit', async e => {
    e.preventDefault();
    const url = $('#importUrl').value.trim();
    toast('抓取中…', 1500);
    try {
      const info = await api('POST', '/api/import-link', { url });
      closeModal();
      let source = '网页';
      if (/weixin\.qq\.com/i.test(url)) source = '微信公众号';
      else if (/xiaohongshu\.com|xhslink/i.test(url)) source = '小红书';
      recordForm(moduleOf('resource'), null, {
        title: info.title, link: url, digest: info.description, source, date: todayStr()
      });
    } catch (err) { toast(err.message); }
  });
}

/* ---------------- 班级下拉：汇总候选 + 排序 ---------------- */
function clazzRank(c) {
  const t = String(c || '');
  const hs = { '高一': 5, '高二': 6, '高三': 7 };
  const gs = { '六': 1, '七': 2, '八': 3, '九': 4 };
  let base = 9;
  for (const k in hs) if (t.startsWith(k)) base = hs[k];
  if (base === 9) for (const k in gs) if (t.startsWith(k)) base = gs[k];
  const mm = t.match(/(\d+)\s*班/);
  return base * 100 + (mm ? parseInt(mm[1], 10) : 0);
}

function allClasses() {
  const set = new Set();
  const add = c => { const s = String(c || '').trim(); if (s && s !== '归档') set.add(s); };
  // 规范班级：初中六/七/八/九年级各 1 个班；高中高一/高二/高三各 6 个班
  ['六', '七', '八', '九'].forEach(g => add(`${g}1班`));
  ['高一', '高二', '高三'].forEach(g => { for (let i = 1; i <= 6; i++) add(`${g}${i}班`); });
  // 兼容历史数据里已有的真实写法（如 七年级 / 六年级1班 / 六年级 · 学生观察），保证旧记录仍可编辑
  (S.state.records || []).forEach(r => add((r.data || {}).clazz));
  return Array.from(set).sort((a, b) => clazzRank(a) - clazzRank(b) || a.localeCompare(b, 'zh'));
}

/* 周期预约分组：优先用显式 apGroup；历史数据靠 code+班级+规则+时间 归并 */
function apGroupKey(d) {
  d = d || {};
  if (d.apGroup) return d.apGroup;
  if (d.apRule) return 'v|' + [d.code || '', d.clazz || '', d.apRule || '', d.time || ''].join('|');
  return null;
}
function newApGroupId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
/* 取一条预约所属的整组记录（历史数据按分组键归并） */
function apGroupItems(r) {
  const gk = apGroupKey(r.data) || ('one|' + r.id);
  return (S.state.records || []).filter(x => x.module === 'appoint' &&
    ((apGroupKey(x.data) || ('one|' + x.id)) === gk));
}
function apGroupModeOf(items) {
  if (!items || items.length <= 1) return 'single';
  return String((items[0].data || {}).apRule || '').includes('手动') ? 'manual' : 'cycle';
}

function classFieldHtml(key, label, v) {
  const opts = allClasses();
  const isCustom = v && !opts.includes(v);
  const options = opts.map(c => `<option value="${esc(c)}"${c === v ? ' selected' : ''}>${esc(c)}</option>`).join('');
  return `<div class="field"><label>${esc(label)}</label>
    <select data-fkey="${esc(key)}" class="clazz-select">
      <option value="">请选择班级</option>${options}
      <option value="__custom__"${isCustom ? ' selected' : ''}>＋ 手动输入新班级…</option>
    </select>
    <input type="text" class="clazz-custom" data-fkey="${esc(key)}" placeholder="输入新班级，如 高一7班" value="${esc(isCustom ? v : '')}" style="margin-top:8px;${isCustom ? '' : 'display:none'}">
  </div>`;
}

function slotRowHtml(date, time, noDel) {
  return `<div class="slot-row" data-slot>
    <input type="date" data-sdate value="${esc(date || '')}" title="预约日期">
    <input type="text" inputmode="numeric" autocomplete="off" data-stime data-time value="${esc(time || '')}" placeholder="时间，如 13:10" title="预约时间">
    ${noDel ? '' : '<button type="button" class="slot-del" title="删除该场次">✕</button>'}
  </div>`;
}

/* ---------------- 预约周期计算（本地日期，避免时区偏移） ---------------- */
function dateAddDays(dateStr, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function weekdayCN(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return '日一二三四五六'[new Date(y, m - 1, d).getDay()];
}

/* 按「每 N 天/周 + 结束方式」生成预约场次；cap 防止一次生成过多 */
function buildRecurringSlots(start, time, everyN, unit, endMode, count, until, cap) {
  cap = cap || 60;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '')) return [];
  const step = (parseInt(everyN, 10) || 1) * (unit === 'week' ? 7 : 1);
  if (!(step > 0)) return [];
  const out = [];
  if (endMode === 'count') {
    const n = Math.max(1, Math.min(parseInt(count, 10) || 1, cap));
    for (let i = 0; i < n; i++) out.push({ date: dateAddDays(start, i * step), time });
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until || '') || until < start) return [];
    let d = start, i = 0;
    while (d <= until && i < cap) { out.push({ date: d, time }); d = dateAddDays(d, step); i++; }
  }
  return out;
}

/* 预约周期：根据当前表单参数刷新「将生成的场次」预览 */
function refreshApPreview() {
  const box = document.getElementById('apPreview');
  if (!box) return;
  const q = s => document.querySelector('#recForm ' + s);
  const start = (q('[data-ap-start]') || {}).value || '';
  const time = normalizeTime(((q('[data-ap-time]') || {}).value || '').trim());
  const every = (q('[data-ap-every]') || {}).value || '1';
  const unit = (q('[data-ap-unit]') || {}).value || 'week';
  const endSel = document.querySelector('#recForm [name="apend"]:checked');
  const endMode = endSel ? endSel.value : 'count';
  const count = (q('[data-ap-count]') || {}).value || '4';
  const until = (q('[data-ap-until]') || {}).value || '';
  const slots = buildRecurringSlots(start, time, every, unit, endMode, count, until);
  if (!slots.length) {
    box.innerHTML = '<div class="ap-empty">请填写首次日期并设置重复规则，预览将显示排期</div>';
    return;
  }
  const shown = slots.slice(0, 12).map((s, i) =>
    `<span class="ap-chip">${i + 1}. ${esc(s.date.slice(5).replace('-', '/'))} 周${weekdayCN(s.date)}${s.time ? ' ' + esc(s.time) : ''}</span>`
  ).join('');
  box.innerHTML = `<div class="ap-sum">将生成 <b>${slots.length}</b> 次预约${slots.length > 12 ? '（前 12 次）' : ''}</div><div class="ap-chips">${shown}${slots.length > 12 ? `<span class="ap-chip more">…还有 ${slots.length - 12} 次</span>` : ''}</div>`;
}

/* 把 apRule 文本解析回周期参数，用于编辑预填 */
function parseApRule(rule, fallbackCount) {
  const out = { every: '1', unit: 'week', endMode: 'count', count: String(fallbackCount || 1), until: '' };
  if (!rule) return out;
  const em = String(rule).match(/每(\d+)(周|天)/);
  if (em) { out.every = em[1]; out.unit = em[2] === '周' ? 'week' : 'day'; }
  const um = String(rule).match(/约到(\d{4}-\d{2}-\d{2})/);
  const cm = String(rule).match(/共(\d+)次/);
  if (um) { out.endMode = 'until'; out.until = um[1]; }
  else if (cm) { out.endMode = 'count'; out.count = cm[1]; }
  return out;
}

/* ================= 记录表单（含附件） ================= */
function recordForm(m, r, preset, apCtx) {
  S.formFiles = {};
  const rd = Object.assign({}, preset || {}, (r && r.data) || {});
  const isAppt = m.key === 'appoint';
  const multiAppoint = isAppt; // 预约统一用「预约安排」区管理日期时间（新增、编辑均可改单次/多次）
  // 预约编辑预填：整组按组规则，单条按 single
  const apPrefill = { mode: 'cycle', start: todayStr(), time: '', every: '1', unit: 'week', endMode: 'count', count: '4', until: '', manual: [] };
  if (isAppt) {
    const grpItems = apCtx && apCtx.items ? apCtx.items : (r ? [r] : []);
    const grpMode = apCtx && apCtx.mode ? apCtx.mode : (r && !apGroupKey(r.data) ? 'single' : 'cycle');
    if (r && grpItems.length) {
      const first = grpItems[0].data;
      apPrefill.start = /^\d{4}-\d{2}-\d{2}$/.test(first.date || '') ? first.date : todayStr();
      apPrefill.time = first.time || '';
      if (grpMode === 'cycle') {
        apPrefill.mode = 'cycle';
        Object.assign(apPrefill, parseApRule(first.apRule, grpItems.length));
      } else if (grpMode === 'manual') {
        apPrefill.mode = 'manual';
        apPrefill.manual = grpItems.map(i => ({ date: i.data.date || '', time: i.data.time || '' }));
      } else {
        apPrefill.mode = 'single';
        apPrefill.start = r.data.date || apPrefill.start;
        apPrefill.time = r.data.time || '';
      }
    }
  }
  const fieldsHtml = m.fields.map(f => {
    if (f.hidden) return '';
    const v = rd[f.key];
    if (multiAppoint && (f.key === 'date' || f.key === 'time')) return '';
    if (f.key === 'clazz') return classFieldHtml(f.key, f.label, v);
    if (f.type === 'textarea') {
      return `<div class="field"><label>${esc(f.label)}</label><textarea data-fkey="${esc(f.key)}">${esc(v)}</textarea></div>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
      return `<div class="field"><label>${esc(f.label)}</label><select data-fkey="${esc(f.key)}"><option value="">请选择</option>${opts}</select></div>`;
    }
    if (f.type === 'files') {
      S.formFiles[f.key] = (v || []).slice();
      return `<div class="field"><label>${esc(f.label)}</label>
        <div class="file-list" id="fl_${esc(f.key)}">${(v || []).map(fileChip).join('') || '<span class="muted-note">暂无附件</span>'}</div>
        <input type="file" multiple data-fileinput="${esc(f.key)}" class="file-input">
        <p class="hint">📎 支持 PDF / PPT / Word / 图片 / 视频等，单个 ≤20MB，可多选</p>
      </div>`;
    }
    if (f.type === 'time') {
      const starts = Array.from(new Set((S.state.config.periods || []).map(p2 => p2.start).filter(Boolean)));
      return `<div class="field"><label>${esc(f.label)}</label>
        <input type="text" inputmode="numeric" autocomplete="off" data-fkey="${esc(f.key)}" data-time="1" value="${esc(v)}" placeholder="如 13:10 —— 只填数字自动补 0（9 → 09:00，930 → 09:30）">
        <div class="time-chips">${starts.map(t => `<button type="button" class="time-chip" data-time-set="${t}">${t}</button>`).join('')}
          <button type="button" class="time-chip ghost" data-time-set="">全天</button></div>
      </div>`;
    }
    const type = f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text';
    let ph = '';
    if (f.type === 'url') ph = 'placeholder="https://…（WPS / 飞书 / IMA 文档链接）"';
    if (f.key === 'code') ph = 'placeholder="拼音首字母，如 MCY（马辰宇）"';
    if (f.key === 'title') ph = 'placeholder="如：高一2 心理课 / 教研组会"';
    const codeHint = f.key === 'code' ? '<p class="hint">🔒 学生姓名请用拼音首字母缩写，例：马辰宇 → MCY、龚宸萱 → GCX</p>' : '';
    return `<div class="field"><label>${esc(f.label)}</label><input type="${type}" data-fkey="${esc(f.key)}" value="${esc(v)}" ${ph}>${codeHint}</div>`;
  }).join('');
  const pf = apPrefill;
  const singleRow = slotRowHtml(pf.start, pf.time, true);
  const manualRows = (pf.manual.length ? pf.manual : [{ date: pf.start, time: pf.time }]).map(x => slotRowHtml(x.date, x.time)).join('');
  const multiHtml = multiAppoint ? `
    <div class="field ap-block">
      <label>预约安排 <span style="font-weight:400;color:var(--muted);font-size:12px">（单次 / 周期重复 / 手动指定，随时可改）</span></label>
      <div class="ap-tabs">
        <button type="button" class="ap-tab${pf.mode === 'single' ? ' active' : ''}" data-apmode="single">单次</button>
        <button type="button" class="ap-tab${pf.mode === 'cycle' ? ' active' : ''}" data-apmode="cycle">🔁 周期重复</button>
        <button type="button" class="ap-tab${pf.mode === 'manual' ? ' active' : ''}" data-apmode="manual">📅 手动指定</button>
      </div>
      <div class="ap-pane" data-appane="single"${pf.mode === 'single' ? '' : ' style="display:none"'}>
        <div id="singleBox">${singleRow}</div>
        <p class="hint">只预约一次，填日期和时间即可。</p>
      </div>
      <div class="ap-pane" data-appane="cycle"${pf.mode === 'cycle' ? '' : ' style="display:none"'}>
        <div class="ap-row">
          <div><label>首次日期</label><input type="date" data-ap-start value="${esc(pf.start)}"></div>
          <div><label>时间</label><input type="text" inputmode="numeric" autocomplete="off" data-ap-time data-time value="${esc(pf.time)}" placeholder="如 15:30"></div>
        </div>
        <div class="ap-row ap-rule">
          <span>每</span><input type="number" min="1" max="52" value="${esc(pf.every)}" data-ap-every><select data-ap-unit><option value="week"${pf.unit === 'week' ? ' selected' : ''}>周</option><option value="day"${pf.unit === 'day' ? ' selected' : ''}>天</option></select><span>重复一次</span>
        </div>
        <div class="ap-end">
          <label><input type="radio" name="apend" value="count"${pf.endMode === 'count' ? ' checked' : ''}> 共约 <input type="number" min="1" max="60" value="${esc(pf.count)}" data-ap-count> 次</label>
          <label><input type="radio" name="apend" value="until"${pf.endMode === 'until' ? ' checked' : ''}> 约到 <input type="date" data-ap-until value="${esc(pf.until)}"></label>
        </div>
        <div class="ap-preview" id="apPreview"></div>
        <p class="hint">按上面规则自动排期，保存后生成多条预约记录（最多 60 次）。</p>
      </div>
      <div class="ap-pane" data-appane="manual"${pf.mode === 'manual' ? '' : ' style="display:none"'}>
        <div id="slotBox">${manualRows}</div>
        <button type="button" class="btn sm" id="addSlotBtn">＋ 添加一次预约</button>
        <p class="hint">逐个指定每次预约的日期和时间。</p>
      </div>
    </div>` : '';
  openModal(`<h2>${r ? '编辑' : '新增'} · ${esc(m.name)}<button class="m-close" data-close>✕</button></h2>
    <form id="recForm">${fieldsHtml}${multiHtml}
      <div class="m-foot"><button type="button" class="btn" data-close>取消</button>
      <button type="submit" class="btn primary">${multiAppoint ? '保存预约' : '保存'}</button></div>
    </form>`, multiAppoint ? 'doc-wide' : '');
  // 班级下拉：选「手动输入新班级」时显示自定义输入框
  $$('#recForm .clazz-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const box = sel.closest('.field');
      const inp = box && box.querySelector('.clazz-custom');
      if (!inp) return;
      const custom = sel.value === '__custom__';
      inp.style.display = custom ? '' : 'none';
      if (custom) { inp.value = ''; inp.focus(); }
    });
  });
  // 多次预约：增删场次
  if (multiAppoint) {
    const slotBox = $('#slotBox');
    $('#addSlotBtn').addEventListener('click', () => {
      slotBox.insertAdjacentHTML('beforeend', slotRowHtml('', ''));
      const rows = $$('#slotBox [data-slot]');
      const last = rows[rows.length - 1];
      if (last) last.querySelector('[data-sdate]').focus();
    });
    slotBox.addEventListener('click', e => {
      const del = e.target.closest('.slot-del');
      if (!del) return;
      if ($$('#slotBox [data-slot]').length <= 1) { toast('至少保留一次预约'); return; }
      del.closest('[data-slot]').remove();
    });
    // 周期 / 手动 模式切换
    $$('#recForm [data-apmode]').forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-apmode');
        $$('#recForm [data-apmode]').forEach(t => t.classList.toggle('active', t === tab));
        $$('#recForm [data-appane]').forEach(p => { p.style.display = p.getAttribute('data-appane') === mode ? '' : 'none'; });
        refreshApPreview();
      });
    });
    // 周期参数变化 → 刷新预览
    $$('#recForm [data-ap-start], #recForm [data-ap-time], #recForm [data-ap-every], #recForm [data-ap-unit], #recForm [data-ap-count], #recForm [data-ap-until], #recForm [name="apend"]').forEach(el => {
      el.addEventListener('input', refreshApPreview);
      el.addEventListener('change', refreshApPreview);
    });
    refreshApPreview();
  }
  // 时间：失焦自动补零 / 点快捷时间
  $$('#recForm [data-time]').forEach(inp => {
    inp.addEventListener('blur', () => {
      const n = normalizeTime(inp.value);
      if (n !== inp.value.trim()) inp.value = n;
    });
  });
  $('#recForm').addEventListener('click', e => {
    const chip = e.target.closest('[data-time-set]');
    if (!chip) return;
    const pane = chip.closest('[data-appane]') || $('#recForm');
    const inp = pane.querySelector('[data-time]');
    if (inp) { inp.value = chip.getAttribute('data-time-set'); inp.focus(); }
  });
  // 类型：按标题自动区分，手动选过就不再覆盖
  const catSel = $('#recForm [data-fkey="cat"]');
  const titleInp = $('#recForm [data-fkey="title"]');
  if (catSel && titleInp) {
    let manual = !!rd.cat;
    catSel.addEventListener('change', () => { manual = true; });
    const apply = () => {
      if (manual) return;
      const g = guessCat(titleInp.value);
      if (g) catSel.value = g;
    };
    titleInp.addEventListener('input', apply);
    titleInp.addEventListener('blur', apply);
    if (!manual) apply();
  }
  $('#recForm').addEventListener('submit', async e => {
    e.preventDefault();
    const collectData = () => {
      const data = r ? Object.assign({}, r.data) : Object.assign({}, preset || {});
      $$('#recForm [data-fkey]').forEach(el => {
        if (el.classList.contains('file-input')) return;
        if (el.classList.contains('clazz-select') && el.value === '__custom__') return;
        if (el.classList.contains('clazz-custom') && el.style.display === 'none') return;
        const isTime = el.hasAttribute('data-time');
        const raw = el.value.trim();
        data[el.getAttribute('data-fkey')] = isTime ? normalizeTime(raw) : raw;
        if (isTime) el.value = data[el.getAttribute('data-fkey')];
      });
      for (const [k, ids] of Object.entries(S.formFiles)) data[k] = ids;
      return data;
    };
    const data = collectData();
    if (data.code && /[\u4e00-\u9fa5]/.test(String(data.code).replace(/[（(].*?[）)]/g, ''))) {
      if (!confirm('代称里还有中文姓名，建议改成拼音首字母（如 马辰宇 → MCY）。仍要保存吗？')) return;
    }

    // 预约：单次 / 周期 / 手动三种模式 → 生成一条或多条预约记录
    if (multiAppoint) {
      const activeTab = $('#recForm [data-apmode].active');
      const activeMode = activeTab ? activeTab.getAttribute('data-apmode') : 'cycle';
      let slots = [];
      const boxSel = activeMode === 'single' ? '#singleBox' : '#slotBox';
      if (activeMode === 'cycle') {
        const start = $('#recForm [data-ap-start]').value.trim();
        const time = normalizeTime($('#recForm [data-ap-time]').value.trim());
        const every = $('#recForm [data-ap-every]').value;
        const unit = $('#recForm [data-ap-unit]').value;
        const endMode = ($('#recForm [name="apend"]:checked') || {}).value || 'count';
        const count = $('#recForm [data-ap-count]').value;
        const until = $('#recForm [data-ap-until]').value.trim();
        if (!start) { toast('请选择首次预约日期'); return; }
        slots = buildRecurringSlots(start, time, every, unit, endMode, count, until);
        if (!slots.length) { toast(endMode === 'until' ? '截止日期需不早于首次日期' : '请检查重复规则'); return; }
      } else {
        slots = $$(boxSel + ' [data-slot]').map(row => ({
          date: row.querySelector('[data-sdate]').value.trim(),
          time: normalizeTime(row.querySelector('[data-stime]').value.trim())
        })).filter(s => s.date || s.time);
        if (!slots.length) { toast('请至少填写一次预约的日期或时间'); return; }
      }
      const base = Object.assign({}, data);
      delete base.date; delete base.time; delete base.apGroup; delete base.apRule;
      // 多场次（周期/手动）写入分组标识，便于合并显示与整组编辑；单次不分组
      if (slots.length > 1) {
        base.apGroup = newApGroupId();
        if (activeMode === 'cycle') {
          base.apRule = `每${$('#recForm [data-ap-every]').value}${$('#recForm [data-ap-unit]').value === 'week' ? '周' : '天'} · ${$('#recForm [name="apend"]:checked').value === 'until' ? '约到' + $('#recForm [data-ap-until]').value : '共' + $('#recForm [data-ap-count]').value + '次'}`;
        } else {
          base.apRule = `手动 ${slots.length} 次`;
        }
      }
      try {
        // 编辑：先删掉旧记录/旧组（整组或用旧分组键找到的所有记录）
        if (r) {
          let delIds = [];
          if (apCtx && apCtx.items) delIds = apCtx.items.map(i => i.id);
          else {
            const oldKey = apGroupKey(r.data);
            delIds = oldKey ? S.state.records.filter(x => x.module === 'appoint' && apGroupKey(x.data) === oldKey).map(x => x.id) : [r.id];
          }
          for (const id of delIds) { await api('DELETE', '/api/records/' + id); }
        }
        for (const slot of slots) {
          await api('POST', '/api/records', { module: m.key, data: Object.assign({}, base, slot) });
        }
        await loadState(); closeModal(); rerender();
        toast(`已保存 ${slots.length} 条预约 ✓`);
      } catch (err) { toast(err.message); }
      return;
    }

    // 课表自动生成的日程：手动改过时间则固定住，避免下次同步被还原
    if (r && r.data && r.data.src === 'timetable' && data.time !== r.data.time) data.timeFixed = true;
    try {
      if (r) {
        const res = await api('PUT', '/api/records/' + r.id, { data });
        bumpLocal(res.version);
      } else {
        const res = await api('POST', '/api/records', { module: m.key, data });
        bumpLocal(res.version);
      }
      await loadState();
      closeModal();
      rerender();
      toast('已保存 ✓');
    } catch (err) { toast(err.message); }
  });
}

async function uploadFiles(fkey, fileList) {
  for (const file of fileList) {
    if (file.size > 20 * 1024 * 1024) { toast(`「${file.name}」超过 20MB，已跳过`); continue; }
    const base64 = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
    try {
      const res = await api('POST', '/api/files', { name: file.name, mime: file.type || 'application/octet-stream', base64 });
      (S.formFiles[fkey] = S.formFiles[fkey] || []).push(res.file.id);
      const box = $('#fl_' + fkey);
      if (box) { const span = box.querySelector('.muted-note'); if (span) span.remove(); box.insertAdjacentHTML('beforeend', fileChip(res.file.id)); }
    } catch (e) { toast(e.message); }
  }
}

/* ================= 设置 ================= */
function viewSettings() {
  const c = S.state.config;
  return `
  <div class="card zc-jw"><h3>🎨 外观与品牌</h3>
    <div class="set-row"><span class="s-label2">头像</span>
      <button type="button" class="logo-pick" id="logoPick" title="点击选择图片（也可把图片拖进来）">
        ${c.logo ? `<img src="${c.logo}" alt="头像">` : '<span class="logo-emoji">🦢</span>'}
        <span class="logo-mask">更换</span>
      </button>
      <div class="logo-tip">
        <b>点头像即可选图</b>，选完立刻生效<br>
        <span class="hint">JPG / PNG / WebP，自动裁成方形；iPhone 的 HEIC 请先在相册转成 JPG</span>
      </div>
      <input type="file" id="logoFile" accept="image/*" hidden>
      ${c.logo ? '<button class="btn sm" id="logoClear">恢复默认</button>' : ''}
    </div>
    <div class="set-row"><span class="s-label2">名称</span><input type="text" id="setAppName" value="${esc(c.appName)}"></div>
    <div class="set-row"><span class="s-label2">主题色</span><input type="color" id="setTheme" value="${esc(c.theme)}" style="height:38px;flex:none;width:60px">
      <button class="btn sm primary" id="saveAppearance">保存外观</button>
    </div>
  </div>

  <div class="card zc-jw"><h3>🗓️ 学期与假期倒计时</h3>
    <div class="set-row"><span class="s-label2">开学日（第1周周一）</span><input type="date" id="setSemester" value="${esc(c.semesterStart)}"></div>
    <div id="holidaysBox">${(c.holidays || []).map((h, i) => `
      <div class="set-row" data-hi="${i}">
        <input type="text" class="h-name" placeholder="假期名" value="${esc(h.name)}" style="flex:1">
        <input type="date" class="h-date" value="${esc(h.date)}">
        <button class="fe-del" data-holiday-del="${i}">✕</button>
      </div>`).join('')}
    </div>
    <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
      <button class="btn sm" id="holidayAdd">＋ 添加假期</button>
      <button class="btn sm primary" id="semesterSave">保存学期与假期</button>
    </div>
  </div>

  <div class="card zc-jw"><h3>⏰ 时间节点（课表节次）</h3>
    <div id="periodsBox">${c.periods.map((p, i) => `
      <div class="set-row" data-pi="${i}">
        <input type="text" class="p-name" value="${esc(p.name)}" style="flex:1">
        <input type="time" class="p-start" value="${esc(p.start)}">
        <input type="time" class="p-end" value="${esc(p.end)}">
        <button class="fe-del" data-period-del="${i}">✕</button>
      </div>`).join('')}
    </div>
    <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
      <button class="btn sm" id="periodAdd">＋ 添加节次</button>
      <button class="btn sm primary" id="periodSave">保存时间节点</button>
    </div>
    <div style="margin-top:14px">
      <label style="font-size:13px;color:var(--muted)">上课日（逗号分隔）</label>
      <div class="set-row"><input type="text" id="setWorkDays" value="${esc(c.workDays.join('，'))}"></div>
    </div>
  </div>

  <div class="card zc-jw"><h3>🎨 课程类型色调（聚合课表区分）</h3>
    <div id="typesBox">${(c.courseTypes || []).map((t, i) => `
      <div class="set-row" data-ti="${i}">
        <input type="text" class="ct-name" value="${esc(t.name)}" style="flex:1">
        <input type="color" class="ct-color" value="${esc(t.color)}" style="height:36px;flex:none;width:54px">
        <button class="fe-del" data-type-del="${i}">✕</button>
      </div>`).join('')}
    </div>
    <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
      <button class="btn sm" id="typeAdd">＋ 添加类型</button>
      <button class="btn sm primary" id="typesSave">保存课程类型</button>
    </div>
  </div>

  <div class="card zc-sw"><h3>🌐 联网资源库 · 订阅源（每日 8 点自动抓取）</h3>
    <p class="hint">小红书与公众号无官方开放API：推荐配置第三方 RSS 服务生成的订阅源（如"WeRSS/feeds.pub"类工具将公众号转为RSS）；公众号文章也可在「教研培训 → 拓展资源库 → 链接导入」一键收藏。</p>
    <div id="rssBox">${(c.rssSources || []).map((s2, i) => `
      <div class="set-row" data-ri="${i}">
        <input type="text" class="rss-name" placeholder="源名称" value="${esc(s2.name || '')}" style="flex:none;width:110px">
        <input type="url" class="rss-url" placeholder="RSS 订阅地址" value="${esc(s2.url || '')}" style="flex:1">
        <button class="fe-del" data-rss-del="${i}">✕</button>
      </div>`).join('')}
    </div>
    <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
      <button class="btn sm" id="rssAdd">＋ 添加订阅源</button>
      <button class="btn sm primary" id="rssSave">保存订阅源</button>
    </div>
  </div>

  <div class="card zc-jw"><h3>🍏 苹果日历同步</h3>
    <p class="hint"><b>① 订阅（工作台 → 苹果日历）</b>：复制下方地址，在苹果日历中「文件 → 新建日历订阅」粘贴即可自动同步日程/待办/预约/假期。⚠️ 地址含访问令牌，请勿外传。</p>
    <div class="set-row"><input type="text" id="icsUrlBox" readonly value="${esc(location.origin)}/api/calendar.ics?t=${encodeURIComponent(TOKEN)}" style="font-size:12px"><button class="btn sm" id="icsUrlCopy">复制</button></div>
    <p class="hint" style="margin-top:12px"><b>② 导入（苹果日历 → 工作台）</b>：在 iCloud 日历「分享 → 公共日历」获得 .ics 地址填入，或直接导入 Mac 日历导出的 .ics 文件；每天 8 点自动同步。</p>
    <div class="set-row"><input type="url" id="setIcsUrl" value="${esc(c.icsImportUrl || '')}" placeholder="iCloud 公开日历 .ics 地址" style="font-size:12.5px"><button class="btn sm primary" id="icsUrlSave">保存地址</button></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center">
      <button class="btn sm" id="icsImportNow">⚡ 立即从地址导入</button>
      <input type="file" id="icsFile" accept=".ics,text/calendar" style="font-size:12px;color:var(--muted)">
      <span class="hint">或选择本地 .ics 文件导入</span>
    </div>
  </div>

  <div class="card zc-sw"><h3>🧩 版块与字段（归属板块可调）</h3>
    <div id="modulesBox">${c.modules.map((m, mi) => moduleEditHtml(m, mi)).join('')}</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn sm" id="moduleAdd">＋ 添加版块</button>
      <button class="btn sm primary" id="modulesSave">保存版块配置</button>
    </div>
  </div>

  <div class="card zc-pv"><h3>🔒 安全 · 隐私保护</h3>
    <p class="hint">🛡️ 「个辅」与「危机干预」为隐私红线区：全局灰色斜纹隔离 + 锁形水印 + 保密横幅，字段请使用编号/化名脱敏。</p>
    <form id="pwForm">
      <div class="field"><label>原密码</label><input type="password" id="pwOld" required></div>
      <div class="row2">
        <div class="field"><label>新密码（≥6位）</label><input type="password" id="pwNew" required></div>
        <div class="field"><label>确认新密码</label><input type="password" id="pwNew2" required></div>
      </div>
      <button class="btn primary" type="submit">修改密码</button>
    </form>
  </div>

  <div class="card zc-pv"><h3>📦 数据 · 隐私保护</h3>
    <button class="btn" id="exportBtn">导出全部数据（JSON）</button>
    <p style="font-size:12.5px;color:var(--muted);margin-top:10px">所有数据与附件保存在云端服务器，多端登录同一密码实时同步；无任何自动分享机制。</p>
  </div>`;
}

function moduleEditHtml(m, mi) {
  const fieldTypes = [['text', '文本'], ['textarea', '长文本'], ['date', '日期'], ['time', '时间'], ['select', '单选'], ['url', '链接'], ['files', '附件'], ['number', '数字']];
  const secOpts = Object.keys(SECTIONS).map(k => `<option value="${k}"${m.section === k ? ' selected' : ''}>${SECTIONS[k].name}</option>`).join('');
  return `<div class="module-edit" data-mi="${mi}">
    <div class="me-head">
      <input type="text" class="me-icon" value="${esc(m.icon)}" style="width:52px;text-align:center" title="图标(emoji)">
      <input type="text" class="me-name" value="${esc(m.name)}" style="flex:1" title="版块名称">
      <select class="me-section" style="padding:8px;border:1.5px solid var(--line);border-radius:9px;flex:none;font-size:13px">${secOpts}</select>
      <button class="fe-del" data-module-del="${mi}">✕</button>
    </div>
    ${m.fields.map((f, fi) => `
      <div class="field-edit-row${f.type === 'select' ? ' has-opts' : ''}">
        <input type="text" class="fe-label" placeholder="字段名" value="${esc(f.label)}">
        <select class="fe-type">${fieldTypes.map(t => `<option value="${t[0]}"${f.type === t[0] ? ' selected' : ''}>${t[1]}</option>`).join('')}</select>
        <input type="text" class="fe-opts" placeholder="选项，逗号分隔" value="${esc((f.options || []).join('，'))}">
        <button class="fe-del" data-field-del="${fi}">✕</button>
      </div>`).join('')}
    <button class="btn sm" data-field-add="${mi}">＋ 添加字段</button>
  </div>`;
}

function collectSettingsModules() {
  const mods = [];
  $$('#modulesBox .module-edit').forEach(box => {
    const icon = $('.me-icon', box).value.trim() || '📁';
    const name = $('.me-name', box).value.trim();
    if (!name) return;
    const secSel = $('.me-section', box);
    const section = secSel && SECTIONS[secSel.value] ? secSel.value : 'admin';
    const key = 'm' + Math.abs([...name].reduce((a, ch) => a * 31 + ch.charCodeAt(0) | 0, 7)).toString(36) + mods.length;
    const fields = [];
    $$('.field-edit-row', box).forEach(row => {
      const label = $('.fe-label', row).value.trim();
      if (!label) return;
      const type = $('.fe-type', row).value;
      const f = { key: 'f' + fields.length, label, type };
      if (type === 'select') f.options = $('.fe-opts', row).value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      fields.push(f);
    });
    mods.push({ key, name, icon, section, fields });
  });
  return mods;
}

/* ---------------- 弹窗 ---------------- */
function openModal(html, cls) {
  $('#modalBox').className = 'modal' + (cls ? ' ' + cls : '');
  $('#modalBox').innerHTML = html;
  $('#modalMask').hidden = false;
  $$('[data-close]', $('#modalBox')).forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() { $('#modalMask').hidden = true; $('#modalBox').innerHTML = ''; S.formFiles = {}; }

/* ---------------- 待办操作 ---------------- */
async function toggleTodo(id) {
  const t = S.state.todos.find(x => x.id === id);
  if (!t) return;
  try {
    const res = await api('PUT', '/api/todos/' + id, { done: !t.done });
    bumpLocal(res.version);
    await loadState();
    rerender();
  } catch (e) { toast(e.message); }
}
async function delTodo(id) {
  try {
    const res = await api('DELETE', '/api/todos/' + id);
    bumpLocal(res.version);
    await loadState();
    rerender();
    toast('已删除');
  } catch (e) { toast(e.message); }
}
async function delRecord(id) {
  if (!confirm('确定删除这条记录？')) return;
  try {
    const res = await api('DELETE', '/api/records/' + id);
    bumpLocal(res.version);
    await loadState();
    rerender();
    toast('已删除');
  } catch (e) { toast(e.message); }
}

/* ---------------- Logo 压缩 ---------------- */
async function applyLogoFile(file) {
  if (!file) return;
  const okType = /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name || '');
  if (!okType) { toast('这个格式读不了，请选 JPG / PNG / WebP（HEIC 请先转成 JPG）', 3500); return; }
  if (file.size > 12 * 1024 * 1024) { toast('图片超过 12MB，换一张小一点的吧'); return; }
  toast('正在处理头像…', 1500);
  try {
    const dataUrl = await fileToLogoData(file);
    const res = await api('POST', '/api/config', { logo: dataUrl });
    bumpLocal(res.version);
    await loadState();
    applyTheme();
    rerender();
    toast('头像已更新 ✓');
  } catch (err) {
    toast((err.message || '处理失败') + '，试试 JPG / PNG 格式', 3500);
  }
}

function fileToLogoData(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        if (!iw || !ih) throw new Error('图片尺寸异常');
        const size = 320;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / iw, size / ih);
        const w = iw * scale, h = ih * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

/* ---------------- 全局事件 ---------------- */
function bindGlobal() {
  $('#loginForm').addEventListener('submit', doLogin);
  $('#menuBtn').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
    $('#drawerMask').classList.toggle('show');
  });
  $('#drawerMask').addEventListener('click', closeDrawer);
  $('#logoutBtn').addEventListener('click', () => {
    TOKEN = '';
    localStorage.removeItem('wb_token');
    showLogin();
  });
  $('#brand').addEventListener('click', () => navigate('overview'));

  document.addEventListener('click', e => {
    const thumb = e.target.closest('[data-lightbox]');
    if (thumb) { openLightbox(thumb.getAttribute('data-lightbox')); return; }
    const docOpen = e.target.closest('[data-doc-open]');
    if (docOpen) { const r = S.state.records.find(x => x.id === docOpen.getAttribute('data-doc-open')); if (r) openDocView(r); return; }
    const docSel = e.target.closest('[data-doc-select]');
    if (docSel) { selectDoc(docSel.getAttribute('data-doc-select')); return; }
    const expCat = e.target.closest('[data-expcat]');
    if (expCat) { S.expCat = expCat.getAttribute('data-expcat') || null; rerender(); return; }
    const caseView = e.target.closest('[data-case-view]');
    if (caseView) {
      const r = S.state.records.find(x => x.id === caseView.getAttribute('data-case-view'));
      if (r) openCaseView(r);
      return;
    }
    const lessonRevise = e.target.closest('[data-lesson-revise]');
    if (lessonRevise) {
      const r = S.state.records.find(x => x.id === lessonRevise.getAttribute('data-lesson-revise'));
      if (r) openLessonEditor(r);
      return;
    }
    const lessonView = e.target.closest('[data-lesson-view]');
    if (lessonView) {
      const r = S.state.records.find(x => x.id === lessonView.getAttribute('data-lesson-view'));
      if (r) openLessonView(r);
      return;
    }
    if (e.target.id === 'lessonImportBtn') { openLessonImport(); return; }
    if (e.target.id === 'docNewBtn') { newDoc(); return; }
    const mdView = e.target.closest('[data-mdview]');
    if (mdView) { e.preventDefault(); openMdPreview(mdView.getAttribute('data-mdview')); return; }
    const trView = e.target.closest('[data-track-view]');
    if (trView && !e.target.closest('[data-rec-edit]')) {
      const r = S.state.records.find(x => x.id === trView.getAttribute('data-track-view'));
      if (r) openTrackView(r);
      return;
    }
    const docEdit = e.target.closest('[data-doc-edit]');
    if (docEdit) { const r = S.state.records.find(x => x.id === docEdit.getAttribute('data-doc-edit')); if (r) openDocEditor(r); return; }
    const evEdit = e.target.closest('[data-ev-edit]');
    if (evEdit) {
      const rec = S.state.records.find(r => r.id === evEdit.getAttribute('data-ev-edit'));
      if (rec) recordForm(moduleOf(rec.module), rec);
      return;
    }
    const ttSync = e.target.closest('[data-tt-sync]');
    if (ttSync) {
      (async () => {
        try {
          const res = await api('POST', '/api/timetable/sync', {});
          bumpLocal(res.version);
          await loadState();
          rerender();
          toast(`日程已同步 · 新增 ${res.created} · 更新 ${res.updated} · 移除 ${res.removed}`);
        } catch (err) { toast('同步失败：' + err.message); }
      })();
      return;
    }
    const calDel = e.target.closest('[data-cal-del]');
    if (calDel) {
      const id = calDel.getAttribute('data-cal-del');
      const dateStr = calDel.getAttribute('data-cal-date');
      if (!confirm('确定删除这条日程吗？删除后不可恢复。')) return;
      (async () => {
        try {
          await api('DELETE', '/api/records/' + id);
          toast('日程已删除');
          rerender();
          if (dateStr) openDayModal(dateStr);
        } catch (err) { toast('删除失败：' + err.message); }
      })();
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) { navigate(nav.getAttribute('data-nav'), nav.getAttribute('data-key') || null); return; }
    const calNav = e.target.closest('[data-cal-nav]');
    if (calNav) {
      const dir = parseInt(calNav.getAttribute('data-cal-nav'), 10);
      let y = S.calYear || new Date().getFullYear();
      let m = S.calMonth || (new Date().getMonth() + 1);
      m += dir;
      if (m < 1) { m = 12; y--; }
      if (m > 12) { m = 1; y++; }
      S.calYear = y; S.calMonth = m;
      rerender(); return;
    }
    if (e.target.closest('[data-cal-today]')) {
      S.calYear = undefined; S.calMonth = undefined;
      rerender(); return;
    }
    const calDay = e.target.closest('[data-cal-day]');
    if (calDay) { openDayModal(calDay.getAttribute('data-cal-day')); return; }
    const rosterCls = e.target.closest('[data-roster-class]');
    if (rosterCls) { S.rosterClass = rosterCls.getAttribute('data-roster-class'); rerender(); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { S.tab = tab.getAttribute('data-tab'); S.search = ''; rerender(); return; }
    const cell = e.target.closest('[data-cell]');
    if (cell) {
      const [day, pi] = cell.getAttribute('data-cell').split('|');
      openCellModal(day, parseInt(pi, 10));
      return;
    }
    const toggle = e.target.closest('[data-todo-toggle]');
    if (toggle) { toggleTodo(toggle.getAttribute('data-todo-toggle')); return; }
    const del = e.target.closest('[data-todo-del]');
    if (del) { delTodo(del.getAttribute('data-todo-del')); return; }
    const recEdit = e.target.closest('[data-rec-edit]');
    if (recEdit) {
      const r = S.state.records.find(x => x.id === recEdit.getAttribute('data-rec-edit'));
      const m = S.tab && S.tab !== 'timetable' ? moduleOf(S.tab) : null;
      if (r && m) {
        if (m.key === 'appoint') {
          const items = apGroupItems(r);
          recordForm(m, r, null, { items, mode: apGroupModeOf(items) });
        } else recordForm(m, r);
      }
      return;
    }
    const recDel = e.target.closest('[data-rec-del]');
    if (recDel) { delRecord(recDel.getAttribute('data-rec-del')); return; }
    const apToggle = e.target.closest('[data-apgroup-toggle]');
    if (apToggle) {
      const key = apToggle.getAttribute('data-apgroup-toggle');
      if (!S.apOpenGroups) S.apOpenGroups = new Set();
      if (S.apOpenGroups.has(key)) S.apOpenGroups.delete(key); else S.apOpenGroups.add(key);
      rerender(); return;
    }
    const apEdit = e.target.closest('[data-apgroup-edit]');
    if (apEdit) {
      const key = apEdit.getAttribute('data-apgroup-edit');
      const items = S.state.records.filter(x => x.module === 'appoint' && (apGroupKey(x.data) || ('one|' + x.id)) === key);
      if (items.length) {
        const m = moduleOf('appoint');
        recordForm(m, items[0], null, { items, mode: apGroupModeOf(items) });
      }
      return;
    }
    const apDel = e.target.closest('[data-apgroup-del]');
    if (apDel) {
      const key = apDel.getAttribute('data-apgroup-del');
      const items = S.state.records.filter(x => x.module === 'appoint' && (apGroupKey(x.data) || ('one|' + x.id)) === key);
      if (!confirm(`确定删除整组共 ${items.length} 次预约？删除后不可恢复。`)) return;
      (async () => {
        try {
          for (const it of items) await api('DELETE', '/api/records/' + it.id);
          await loadState(); rerender(); toast(`已删除 ${items.length} 条预约`);
        } catch (err) { toast('删除失败：' + err.message); }
      })();
      return;
    }
    const rdel = e.target.closest('[data-rss-del]');
    if (rdel) { const row = rdel.closest('[data-ri]'); if (row) row.remove(); return; }
    const pdel = e.target.closest('[data-period-del]');
    if (pdel) { const row = pdel.closest('[data-pi]'); if (row) row.remove(); return; }
    const hdel = e.target.closest('[data-holiday-del]');
    if (hdel) { const row = hdel.closest('[data-hi]'); if (row) row.remove(); return; }
    const tdel = e.target.closest('[data-type-del]');
    if (tdel) { const row = tdel.closest('[data-ti]'); if (row) row.remove(); return; }
    const fdel = e.target.closest('[data-field-del]');
    if (fdel) { fdel.closest('.field-edit-row').remove(); return; }
    const mdel = e.target.closest('[data-module-del]');
    if (mdel) {
      if (confirm('删除该版块将隐藏其记录，确定？')) mdel.closest('.module-edit').remove();
      return;
    }
    const fadd = e.target.closest('[data-field-add]');
    if (fadd) {
      const box = fadd.closest('.module-edit');
      const r = document.createElement('div');
      r.className = 'field-edit-row';
      r.innerHTML = `<input type="text" class="fe-label" placeholder="字段名"><select class="fe-type"><option value="text">文本</option><option value="textarea">长文本</option><option value="date">日期</option><option value="time">时间</option><option value="select">单选</option><option value="url">链接</option><option value="files">附件</option><option value="number">数字</option></select><input type="text" class="fe-opts" placeholder="选项，逗号分隔" style="display:none"><button class="fe-del">✕</button>`;
      r.querySelector('.fe-del').addEventListener('click', () => r.remove());
      box.insertBefore(r, fadd);
      return;
    }
  });

  $('#main').addEventListener('click', async e => {
    if (e.target.id === 'recAddBtn' || e.target.id === 'swapQuickBtn' || e.target.id === 'swapAddBtn') {
      const key = e.target.id === 'recAddBtn' ? S.tab : 'swap';
      const m = moduleOf(key);
      if (m) recordForm(m, null);
      return;
    }
    if (e.target.id === 'wkPrev') { S.weekOffset--; rerender(); return; }
    if (e.target.id === 'wkNext') { S.weekOffset++; rerender(); return; }
    if (e.target.id === 'wkBack') { S.weekOffset = 0; rerender(); return; }
    if (e.target.id === 'importLinkBtn') { openImportModal(); return; }
    if (e.target.id === 'fetchRssBtn') {
      toast('抓取订阅源中…', 2000);
      try {
        const r = await api('POST', '/api/fetch-rss');
        await loadState(); rerender();
        toast(`抓取完成：新增 ${r.added} 条${r.errors.length ? '，' + r.errors.length + ' 个源失败' : ''}`, 3000);
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'dailyAddBtn') {
      recordForm(moduleOf('daily'), null, { date: todayStr() });
      return;
    }
    if (e.target.id === 'reportCopyBtn') {
      const txt = $('#reportText').value;
      try { await navigator.clipboard.writeText(txt); toast('日报已复制 📋'); }
      catch (e2) { $('#reportText').select(); document.execCommand('copy'); toast('日报已复制 📋'); }
      return;
    }
    if (e.target.id === 'flashSaveBtn') {
      const content = $('#flashText').value.trim();
      if (!content) return toast('写点什么再保存吧');
      try {
        const res = await api('POST', '/api/records', { module: 'flash', data: { content, tag: $('#flashTag').value } });
        bumpLocal(res.version);
        await loadState(); rerender();
        toast('⚡ 闪念已捕获');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'quoteAnother') {
      let n; do { n = Math.floor(Math.random() * QUOTES.length); } while (n === (S.quoteIdx === undefined ? Math.floor(Date.now() / 864e5) % QUOTES.length : S.quoteIdx));
      S.quoteIdx = n; rerender(); return;
    }
    if (e.target.id === 'quoteCopy') {
      const q = QUOTES[S.quoteIdx === undefined ? Math.floor(Date.now() / 864e5) % QUOTES.length : S.quoteIdx];
      try { await navigator.clipboard.writeText('"' + q.t + '" —— ' + q.s); toast('已复制 📋'); } catch (e2) { toast('复制失败'); }
      return;
    }
    if (e.target.id === 'breathStart') { startBreath(); return; }
    if (e.target.id === 'breathStop') { stopBreath(); return; }
    if (e.target.id === 'noiseStop') { stopNoise(); toast('已停止'); return; }
    const noiseBtn = e.target.closest('[data-noise]');
    if (noiseBtn) { startNoise(noiseBtn.getAttribute('data-noise')); return; }
    const audioDel = e.target.closest('[data-audio-del]');
    if (audioDel) {
      const fid = audioDel.getAttribute('data-audio-del');
      const list = (S.state.config.relaxAudio || []).filter(x => x !== fid);
      try {
        const res = await api('POST', '/api/config', { relaxAudio: list });
        bumpLocal(res.version);
        await api('DELETE', '/api/files/' + fid);
        await loadState(); rerender();
        toast('已移除');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'saveAppearance') {
      let logo = S.state.config.logo;
      try {
        const res = await api('POST', '/api/config', {
          appName: $('#setAppName').value.trim() || 'miao的工作台',
          theme: $('#setTheme').value,
          logo
        });
        bumpLocal(res.version);
        await loadState();
        applyTheme(); rerender();
        toast('外观已保存 ✓');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'logoClear') {
      try {
        const res = await api('POST', '/api/config', { logo: '' });
        bumpLocal(res.version);
        await loadState(); rerender(); toast('已恢复默认 Logo');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'calAddEvent') {
      recordForm(moduleOf('calevent'), null, { date: todayStr() });
      return;
    }
    if (e.target.id === 'calNoticeImport') {
      openNoticeImport('');
      return;
    }
    const tAdd = e.target.closest('[data-track-add]');
    if (tAdd) {
      const les = S.state.records.find(x => x.id === tAdd.getAttribute('data-track-add'));
      if (les) recordForm(moduleOf('track'), null, { lessonId: les.id, lesson: les.data.title || '', date: todayStr() });
      return;
    }
    if (e.target.closest('#logoPick')) {
      const inp = $('#logoFile');
      if (inp) inp.click();
      return;
    }
    if (e.target.id === 'icsUrlCopy') {
      try { await navigator.clipboard.writeText($('#icsUrlBox').value); toast('订阅地址已复制 📋'); } catch (e2) { $('#icsUrlBox').select(); document.execCommand('copy'); toast('订阅地址已复制 📋'); }
      return;
    }
    if (e.target.id === 'icsUrlSave') {
      try {
        const res = await api('POST', '/api/config', { icsImportUrl: $('#setIcsUrl').value.trim() });
        bumpLocal(res.version);
        await loadState(); rerender();
        toast('ICS 订阅地址已保存，每天 8 点自动导入');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'icsImportNow') {
      toast('导入中…', 1500);
      try {
        const r = await api('POST', '/api/import-ics', { url: S.state.config.icsImportUrl || $('#setIcsUrl').value.trim() });
        await loadState(); rerender();
        toast(`导入完成：新增 ${r.added} 条，跳过重复 ${r.skipped} 条`, 3000);
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'holidayAdd') {
      const box = document.createElement('div');
      box.className = 'set-row';
      box.innerHTML = `<input type="text" class="h-name" placeholder="假期名" style="flex:1"><input type="date" class="h-date"><button class="fe-del">✕</button>`;
      box.querySelector('.fe-del').addEventListener('click', () => box.remove());
      $('#holidaysBox').appendChild(box);
      return;
    }
    if (e.target.id === 'semesterSave') {
      const holidays = $$('#holidaysBox .set-row').map(row => ({
        name: $('.h-name', row).value.trim() || '假期',
        date: $('.h-date', row).value
      })).filter(h => h.date);
      try {
        const res = await api('POST', '/api/config', { semesterStart: $('#setSemester').value || '2026-08-31', holidays });
        bumpLocal(res.version);
        await loadState(); rerender();
        toast('学期与假期已保存 ✓');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'periodAdd') {
      const box = document.createElement('div');
      box.className = 'set-row';
      box.innerHTML = `<input type="text" class="p-name" placeholder="节次名" style="flex:1"><input type="time" class="p-start"><input type="time" class="p-end"><button class="fe-del">✕</button>`;
      box.querySelector('.fe-del').addEventListener('click', () => box.remove());
      $('#periodsBox').appendChild(box);
      return;
    }
    if (e.target.id === 'periodSave') {
      const periods = $$('#periodsBox .set-row').map(row => ({
        name: $('.p-name', row).value.trim() || '节次',
        start: $('.p-start', row).value || '08:00',
        end: $('.p-end', row).value || '08:45'
      }));
      const workDays = $('#setWorkDays').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      if (!periods.length || !workDays.length) return toast('至少保留一个节次和一个上课日');
      try {
        const res = await api('POST', '/api/config', { periods, workDays });
        bumpLocal(res.version);
        await loadState(); rerender();
        toast('时间节点已保存 ✓');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'typeAdd') {
      const box = document.createElement('div');
      box.className = 'set-row';
      box.innerHTML = `<input type="text" class="ct-name" placeholder="类型名" style="flex:1"><input type="color" class="ct-color" value="#7A8699" style="height:36px;flex:none;width:54px"><button class="fe-del">✕</button>`;
      box.querySelector('.fe-del').addEventListener('click', () => box.remove());
      $('#typesBox').appendChild(box);
      return;
    }
    if (e.target.id === 'typesSave') {
      const courseTypes = $$('#typesBox .set-row').map(row => ({
        name: $('.ct-name', row).value.trim(),
        color: $('.ct-color', row).value
      })).filter(t => t.name);
      if (!courseTypes.length) return toast('至少保留一个课程类型');
      try {
        const res = await api('POST', '/api/config', { courseTypes });
        bumpLocal(res.version);
        await loadState(); rerender();
        toast('课程类型已保存 ✓');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'rssAdd') {
      const box = document.createElement('div');
      box.className = 'set-row';
      box.innerHTML = `<input type="text" class="rss-name" placeholder="源名称" style="flex:none;width:110px"><input type="url" class="rss-url" placeholder="RSS 订阅地址" style="flex:1"><button class="fe-del">✕</button>`;
      box.querySelector('.fe-del').addEventListener('click', () => box.remove());
      $('#rssBox').appendChild(box);
      return;
    }
    if (e.target.id === 'rssSave') {
      const rssSources = $$('#rssBox .set-row').map(row => ({
        name: $('.rss-name', row).value.trim() || '订阅源',
        url: $('.rss-url', row).value.trim()
      })).filter(s2 => s2.url);
      try {
        const res = await api('POST', '/api/config', { rssSources });
        bumpLocal(res.version);
        await loadState(); rerender();
        toast(`订阅源已保存（${rssSources.length} 个），每天 8 点自动抓取`);
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'modulesSave') {
      const mods = collectSettingsModules();
      if (!mods.length) return toast('至少保留一个版块');
      try {
        const res = await api('POST', '/api/config', { modules: mods });
        bumpLocal(res.version);
        await loadState();
        renderNav(); rerender();
        toast('版块配置已保存 ✓');
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'moduleAdd') {
      const box = document.createElement('div');
      box.className = 'module-edit';
      const secOpts = Object.keys(SECTIONS).map(k => `<option value="${k}">${SECTIONS[k].name}</option>`).join('');
      box.innerHTML = `<div class="me-head">
        <input type="text" class="me-icon" value="📁" style="width:52px;text-align:center">
        <input type="text" class="me-name" placeholder="新版块名称" style="flex:1">
        <select class="me-section" style="padding:8px;border:1.5px solid var(--line);border-radius:9px;flex:none;font-size:13px">${secOpts}</select>
        <button class="fe-del">✕</button></div>`;
      box.querySelector('.me-head .fe-del').addEventListener('click', () => box.remove());
      const r = document.createElement('div');
      r.className = 'field-edit-row';
      r.innerHTML = `<input type="text" class="fe-label" placeholder="字段名"><select class="fe-type"><option value="text">文本</option><option value="textarea">长文本</option><option value="date">日期</option><option value="time">时间</option><option value="select">单选</option><option value="url">链接</option><option value="files">附件</option><option value="number">数字</option></select><input type="text" class="fe-opts" placeholder="选项，逗号分隔" style="display:none"><button class="fe-del">✕</button>`;
      r.querySelector('.fe-del').addEventListener('click', () => r.remove());
      const addBtn = document.createElement('button');
      addBtn.className = 'btn sm';
      addBtn.textContent = '＋ 添加字段';
      addBtn.addEventListener('click', () => {
        const r2 = document.createElement('div');
        r2.className = 'field-edit-row';
        r2.innerHTML = r.innerHTML;
        r2.querySelector('.fe-del').addEventListener('click', () => r2.remove());
        box.insertBefore(r2, addBtn);
      });
      box.appendChild(r);
      box.appendChild(addBtn);
      $('#modulesBox').appendChild(box);
      return;
    }
    if (e.target.id === 'exportBtn') {
      const blob = new Blob([JSON.stringify(S.state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'miao-workbench-backup-' + todayStr() + '.json';
      a.click();
      return;
    }
  });

  $('#main').addEventListener('submit', async e => {
    if (e.target.id === 'comfortGateForm') {
      e.preventDefault();
      const pw = $('#comfortGateInput').value;
      if (pw === COMFORT_PASS) {
        sessionStorage.setItem('wb_comfort_ok', '1');
        rerender();
        toast('已开启安抚银行 💚');
      } else {
        const err = $('#comfortGateErr');
        if (err) err.textContent = '口令不对，请再试一次';
        const inp = $('#comfortGateInput');
        if (inp) { inp.value = ''; inp.focus(); }
      }
      return;
    }
    if (e.target.id === 'todoQuickForm') {
      e.preventDefault();
      const text = $('#todoText').value.trim();
      if (!text) return;
      try {
        const res = await api('POST', '/api/todos', { text, due: $('#todoDue').value, priority: $('#todoPrio').value });
        bumpLocal(res.version);
        await loadState();
        rerender();
        toast('已添加 ✓');
      } catch (err) { toast(err.message); }
    }
    if (e.target.id === 'pwForm') {
      e.preventDefault();
      const o = $('#pwOld').value, n = $('#pwNew').value, n2 = $('#pwNew2').value;
      if (n !== n2) return toast('两次新密码不一致');
      try {
        await api('POST', '/api/password', { old: o, new: n });
        TOKEN = '';
        localStorage.removeItem('wb_token');
        toast('密码已修改，请重新登录');
        setTimeout(showLogin, 800);
      } catch (err) { toast(err.message); }
    }
  });

  $('#main').addEventListener('input', e => {
    if (e.target.id === 'recSearch') {
      S.search = e.target.value;
      const pos = e.target.selectionStart;
      if (S.view === 'section' && S.tab === 'trainnote') { refreshDocList(); return; }
      rerender();
      const inp = $('#recSearch');
      if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (e2) {} }
    }
  });
  // 头像：选图 / 拖图 → 立即生效
  document.addEventListener('change', async e => {
    if (e.target && e.target.id === 'logoFile') {
      applyLogoFile(e.target.files && e.target.files[0]);
      return;
    }
    // 弹窗（#modalBox）不在 #main 内，这里统一处理附件上传
    if (e.target.hasAttribute && e.target.hasAttribute('data-fileinput')) {
      const fkey = e.target.getAttribute('data-fileinput');
      if (e.target.files && e.target.files.length) {
        toast('上传中…', 1200);
        await uploadFiles(fkey, e.target.files);
        e.target.value = '';
      }
    }
  });
  document.addEventListener('dragover', e => { if (e.target.closest('#logoPick')) { e.preventDefault(); e.target.closest('#logoPick').classList.add('drag'); } });
  document.addEventListener('dragleave', e => { const p2 = e.target.closest('#logoPick'); if (p2) p2.classList.remove('drag'); });
  document.addEventListener('drop', e => {
    const p2 = e.target.closest('#logoPick');
    if (!p2) return;
    e.preventDefault();
    p2.classList.remove('drag');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) applyLogoFile(f);
  });

  $('#main').addEventListener('change', async e => {
    if (e.target.classList.contains('fe-type')) {
      const row = e.target.closest('.field-edit-row');
      row.classList.toggle('has-opts', e.target.value === 'select');
      return;
    }
    if (e.target.id === 'noiseVol' && noiseGain) {
      noiseGain.gain.value = parseFloat(e.target.value);
      return;
    }
    if (e.target.id === 'icsFile') {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const base64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1]);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      toast('解析 .ics 中…', 1200);
      try {
        const r = await api('POST', '/api/import-ics', { icsBase64: base64 });
        await loadState(); rerender();
        toast(`导入完成：新增 ${r.added} 条，跳过重复 ${r.skipped} 条`, 3000);
      } catch (err) { toast(err.message); }
      e.target.value = '';
      return;
    }
    if (e.target.id === 'relaxAudioInput') {
      if (!e.target.files || !e.target.files.length) return;
      toast('上传中…', 1200);
      const ids = (S.state.config.relaxAudio || []).slice();
      for (const file of e.target.files) {
        if (file.size > 20 * 1024 * 1024) { toast(`「${file.name}」超过 20MB，已跳过`); continue; }
        const base64 = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result).split(',')[1]);
          fr.onerror = reject;
          fr.readAsDataURL(file);
        });
        try {
          const res = await api('POST', '/api/files', { name: file.name, mime: file.type || 'audio/mpeg', base64 });
          ids.push(res.file.id);
        } catch (err) { toast(err.message); }
      }
      try {
        const res = await api('POST', '/api/config', { relaxAudio: ids });
        bumpLocal(res.version);
        await loadState(); rerender();
        toast('音频已加入 🎵');
      } catch (err) { toast(err.message); }
      e.target.value = '';
      return;
    }
    const mv = e.target.closest('[data-kanban-move]');
    if (mv) {
      const id = mv.getAttribute('data-kanban-move');
      const r = S.state.records.find(x => x.id === id);
      const m = moduleOf(S.tab);
      if (r && m) {
        const data = Object.assign({}, r.data);
        data[m.groupField] = mv.value;
        try {
          const res = await api('PUT', '/api/records/' + id, { data });
          bumpLocal(res.version);
          await loadState();
          rerender();
          toast('已移动 → ' + mv.value);
        } catch (err) { toast(err.message); }
      }
    }
  });

  $('#modalMask').addEventListener('click', e => {
    if (e.target === $('#modalMask')) closeModal();
  });
}

function closeDrawer() {
  $('#sidebar').classList.remove('open');
  $('#drawerMask').classList.remove('show');
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  bindGlobal();
  if (TOKEN) {
    try { await enterApp(); return; } catch (e) { /* token 失效走登录 */ }
  }
  showLogin();
})();
