/**
 * 任务看板生成器（计划可视化）：
 *   pnpm exec tsx scripts/plan-dashboard.ts            # 生成 docs/plan/dashboard.html + dashboard.json + issue-map.json
 *   GH_TOKEN=xxx pnpm exec tsx scripts/plan-dashboard.ts  # 额外拉取 Issue 实时状态（open/closed）
 *
 * 数据源：docs/plan/tasks.json（28 个任务的唯一真相源）
 * 输出：纯静态 HTML（无外部依赖、无脚本注入），可直接提交进仓库并用 GitHub Pages 打开。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const planDir = join(repoRoot, 'docs/plan');
const tasksPath = join(planDir, 'tasks.json');

interface Task {
  id: string;
  title: string;
  owner: string;
  milestone: string;
  labels: string[];
  deps: string[];
  body: string;
}

interface IssueInfo {
  number: number;
  state: 'open' | 'closed';
  url: string;
}

const OWNERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const ROLE: Record<string, string> = {
  A: '平台与集成',
  B: '问答链路后端',
  C: '可信拒答策略',
  D: '前端问答体验',
  E: '数据与语料治理',
  F: '评测与实验',
};
const SIZE_DAYS: Record<string, number> = { S: 0.5, M: 1.5, L: 2 };

function sizeOf(labels: string[]): string {
  return labels.find((l) => l.startsWith('size:'))?.split(':')[1] ?? 'M';
}

function readTasks(): Task[] {
  return JSON.parse(readFileSync(tasksPath, 'utf8')) as Task[];
}

/** Kahn 分层：同层可并行；层号越小越早。层内按任务编号排序。 */
export function computeWaves(tasks: Task[]): Map<string, number> {
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  const indeg = new Map(tasks.map((t) => [t.id, t.deps.length]));
  const children = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.deps) children.set(d, [...(children.get(d) ?? []), t.id]);
  const wave = new Map<string, number>();
  let ready = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  let level = 0;
  while (ready.length > 0) {
    const next: string[] = [];
    for (const id of [...ready].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
      wave.set(id, level);
      for (const c of children.get(id) ?? []) {
        const left = (indeg.get(c) ?? 1) - 1;
        indeg.set(c, left);
        if (left === 0) next.push(c);
      }
    }
    ready = next;
    level += 1;
  }
  if (wave.size !== tasks.length) throw new Error('任务依赖存在环，无法分层');
  return wave;
}

/** 关键路径：按规模加权的最长链（返回任务 id 序列与总人日）。 */
export function computeCriticalPath(tasks: Task[]): { path: string[]; days: number } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, { days: number; path: string[] }>();
  const visit = (id: string): { days: number; path: string[] } => {
    const cached = memo.get(id);
    if (cached) return cached;
    const t = byId.get(id);
    if (!t) throw new Error(`未知任务：${id}`);
    let best = { days: 0, path: [] as string[] };
    for (const d of t.deps) {
      const r = visit(d);
      if (r.days > best.days) best = r;
    }
    const result = { days: best.days + (SIZE_DAYS[sizeOf(t.labels)] ?? 1.5), path: [...best.path, id] };
    memo.set(id, result);
    return result;
  };
  let best = { days: 0, path: [] as string[] };
  for (const t of tasks) {
    const r = visit(t.id);
    if (r.days > best.days) best = r;
  }
  return best;
}

async function fetchIssues(): Promise<Map<string, IssueInfo>> {
  const token = process.env.GH_TOKEN;
  const map = new Map<string, IssueInfo>();
  if (!token) return map;
  const res = await fetch('https://api.github.com/repos/2019wakeup/AI_RAG/issues?state=all&per_page=100', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'plan-dashboard' },
  });
  if (!res.ok) throw new Error(`拉取 Issue 失败：${res.status}`);
  const list = (await res.json()) as Array<{ number: number; state: string; html_url: string; title: string; pull_request?: unknown }>;
  for (const it of list) {
    if (it.pull_request) continue;
    const m = /^\[(T\d+)\]/.exec(it.title);
    if (m) map.set(m[1] as string, { number: it.number, state: it.state === 'closed' ? 'closed' : 'open', url: it.html_url });
  }
  return map;
}

function readIssueMapFile(): Map<string, IssueInfo> {
  const p = join(planDir, 'issue-map.json');
  const map = new Map<string, IssueInfo>();
  if (!existsSync(p)) return map;
  const rows = JSON.parse(readFileSync(p, 'utf8')) as Array<{ id: string; number: number; state: string; url: string }>;
  for (const r of rows) map.set(r.id, { number: r.number, state: r.state === 'closed' ? 'closed' : 'open', url: r.url });
  return map;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function buildHtml(data: {
  tasks: Task[];
  wave: Map<string, number>;
  critical: { path: string[]; days: number };
  issues: Map<string, IssueInfo>;
}): string {
  const { tasks, wave, critical, issues } = data;
  const levels = Math.max(...[...wave.values()]) + 1;
  const done = tasks.filter((t) => issues.get(t.id)?.state === 'closed').length;
  const pct = Math.round((done / tasks.length) * 100);

  const cards = tasks.map((t) => {
    const issue = issues.get(t.id);
    const state = issue?.state ?? 'open';
    const isCritical = critical.path.includes(t.id);
    const blocked = t.labels.includes('blocked');
    return {
      id: t.id,
      title: t.title,
      owner: t.owner,
      role: ROLE[t.owner] ?? '',
      milestone: t.milestone,
      wave: wave.get(t.id) ?? 0,
      deps: t.deps,
      size: sizeOf(t.labels),
      blocked,
      state,
      issue: issue?.number ?? null,
      url: issue?.url ?? null,
      critical: isCritical,
    };
  });

  const payload = {
    repo: 'https://github.com/2019wakeup/AI_RAG',
    tasks: cards,
    owners: OWNERS.map((o) => ({ owner: o, role: ROLE[o] })),
    levels,
    critical: critical.path,
    criticalDays: critical.days,
    progress: { done, total: tasks.length, pct },
    generatedAt: new Date().toISOString(),
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI_RAG · 任务看板（拓扑顺序）</title>
<style>
:root{--bg:#0f1420;--panel:#161d2c;--line:#26304a;--fg:#e6ebf5;--muted:#8c99b3;--accent:#4f8cff;--ok:#2ea043;--warn:#d29922;--crit:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC",sans-serif}
header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:16px;align-items:center}
h1{font-size:18px;margin:0} .sub{color:var(--muted);font-size:12px}
.bar{flex:1;min-width:220px;height:10px;background:#0b1020;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#2ea043,#4f8cff);width:${pct}%}
.tabs{display:flex;gap:8px;padding:12px 24px;border-bottom:1px solid var(--line)}
.tabs button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 14px;cursor:pointer}
.tabs button.on{border-color:var(--accent);color:#fff;background:#1b2740}
main{padding:20px 24px 60px}
.board{display:grid;gap:12px;grid-auto-flow:column;grid-auto-columns:minmax(210px,1fr);overflow-x:auto;padding-bottom:12px}
.col{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px;min-height:120px}
.col h3{margin:0 0 8px;font-size:13px;color:var(--muted);font-weight:600}
.card{background:#0d1424;border:1px solid var(--line);border-left:3px solid #3b4a6b;border-radius:10px;padding:8px 10px;margin-bottom:8px;cursor:pointer;transition:transform .08s ease}
.card:hover{transform:translateY(-1px);border-color:var(--accent)}
.card.done{border-left-color:var(--ok);opacity:.72}
.card.crit{border-left-color:var(--crit)}
.card.blocked{outline:1px dashed var(--warn)}
.card .t{font-size:12.5px;font-weight:600;margin:2px 0 4px}
.card .m{font-size:11px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap}
.tag{border:1px solid var(--line);border-radius:99px;padding:0 6px;font-size:10.5px}
.owner{font-weight:700;color:#9ecbff}
svg{width:100%;height:auto;display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:12px;padding:10px 0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}
a{color:var(--accent)} .hidden{display:none}
</style>
</head>
<body>
<header>
  <div>
    <h1>AI_RAG · 任务看板（拓扑顺序）</h1>
    <div class="sub">数据：<a href="./task-topology.md">docs/plan/task-topology.md</a> / <a href="./tasks.json">tasks.json</a> ｜ 生成于 ${escapeHtml(payload.generatedAt)}</div>
  </div>
  <div style="min-width:260px;flex:1">
    <div class="sub" style="margin-bottom:6px">进度 <b id="pct">${pct}%</b>（<span id="done">${done}</span>/${tasks.length} 个任务关闭）</div>
    <div class="bar"><i></i></div>
  </div>
  <div class="sub">关键路径 <b>${critical.days}</b> 人日 ｜ 波次 <b>${levels}</b> 层</div>
</header>
<div class="tabs">
  <button class="on" data-view="wave">按波次（拓扑）</button>
  <button data-view="owner">按成员</button>
  <button data-view="graph">依赖图</button>
  <a href="${payload.repo}/issues" style="margin-left:auto;align-self:center;font-size:12px">GitHub Issues ↗</a>
</div>
<main>
  <div id="wave" class="board"></div>
  <div id="owner" class="board hidden"></div>
  <div id="graph" class="hidden"><svg id="dag" viewBox="0 0 1280 700" preserveAspectRatio="xMinYMin meet"></svg>
    <div class="legend"><span><i class="dot" style="background:var(--crit)"></i>关键路径</span><span><i class="dot" style="background:var(--ok)"></i>已完成</span><span><i class="dot" style="background:#3b4a6b"></i>待办</span><span><i class="dot" style="background:var(--warn)"></i>blocked</span></div>
  </div>
</main>
<script>
const DATA = ${JSON.stringify(payload)};
const byId = Object.fromEntries(DATA.tasks.map(t => [t.id, t]));
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function card(t){
  const cls = ['card', t.state==='closed'?'done':'', t.critical?'crit':'', t.blocked?'blocked':''].join(' ');
  const link = t.url ? \`<a href="\${t.url}" target="_blank" rel="noopener">#\${t.issue}</a>\` : '<span style="color:#667">未建 Issue</span>';
  return \`<div class="\${cls}" title="\${esc(t.deps.length?('依赖：'+t.deps.join(', ')):'无依赖')}">
    <div class="m"><span class="owner">\${t.owner}</span><span class="tag">\${t.size}</span><span class="tag">\${esc(t.milestone)}</span>\${t.blocked?'<span class="tag" style="color:var(--warn)">blocked</span>':''}</div>
    <div class="t">\${esc(t.id)} · \${esc(t.title)}</div>
    <div class="m"><span>\${esc(t.role)}</span><span>\${link}</span>\${t.critical?'<span class="tag" style="color:var(--crit)">关键路径</span>':''}</div>
  </div>\`;
}
function renderWave(){
  const el = document.getElementById('wave'); el.innerHTML='';
  const maxWave = Math.max(...DATA.tasks.map(t=>t.wave));
  for(let w=0; w<=maxWave; w++){
    const col=document.createElement('div'); col.className='col';
    const items=DATA.tasks.filter(t=>t.wave===w);
    col.innerHTML=\`<h3>Wave \${w} · \${items.length} 项</h3>\` + items.map(card).join('');
    el.appendChild(col);
  }
}
function renderOwner(){
  const el=document.getElementById('owner'); el.innerHTML='';
  for(const o of DATA.owners){
    const col=document.createElement('div'); col.className='col';
    const items=DATA.tasks.filter(t=>t.owner===o.owner).sort((a,b)=>a.wave-b.wave);
    col.innerHTML=\`<h3>\${o.owner} · \${esc(o.role)}（\${items.length}）</h3>\` + items.map(card).join('');
    el.appendChild(col);
  }
}
function renderGraph(){
  const svg=document.getElementById('dag');
  const W=1280,H=700, padX=170, padY=60;
  const maxWave=Math.max(...DATA.tasks.map(t=>t.wave));
  const owners=DATA.owners.map(o=>o.owner);
  const x = t => padX + (t.wave/Math.max(1,maxWave))*(W-2*padX);
  const y = t => padY + owners.indexOf(t.owner)*( (H-2*padY)/Math.max(1,owners.length-1) );
  const lines=[]; const nodes=[];
  for(const t of DATA.tasks){
    for(const d of t.deps){
      if(!byId[d]) continue;
      const a=byId[d], b=t; const crit=DATA.critical.includes(a.id)&&DATA.critical.includes(b.id);
      lines.push(\`<line x1="\${x(a)}" y1="\${y(a)}" x2="\${x(b)}" y2="\${y(b)}" stroke="\${crit?'var(--crit)':'#2b3a5c'}" stroke-width="\${crit?2:1}" marker-end="url(#arrow)"/>\`);
    }
  }
  for(const t of DATA.tasks){
    const fill = t.state==='closed' ? 'var(--ok)' : (t.blocked? 'var(--warn)' : (t.critical? 'var(--crit)':'#3b4a6b'));
    const label = t.id;
    nodes.push(\`<g class="node"><circle cx="\${x(t)}" cy="\${y(t)}" r="9" fill="\${fill}" stroke="#0b1020" stroke-width="2"/>
      <text x="\${x(t)+13}" y="\${y(t)+4}" fill="#c9d4ea" font-size="10.5">\${label}</text></g>\`);
  }
  const axis = owners.map((o,i)=>\`<text x="16" y="\${y({owner:o})}" fill="#8c99b3" font-size="11">\${o} · \${esc(DATA.owners[i].role)}</text>\`);
  for(let w=0;w<=maxWave;w++){
    axis.push(\`<text x="\${padX + (w/Math.max(1,maxWave))*(W-2*padX)}" y="\${H-14}" fill="#8c99b3" font-size="11" text-anchor="middle">Wave \${w}</text>\`);
  }
  svg.innerHTML = \`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2b3a5c"/></marker></defs>\` + lines.join('') + nodes.join('') + axis.join('');
}
document.querySelectorAll('.tabs button').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
    for(const id of ['wave','owner','graph']){ document.getElementById(id).classList.toggle('hidden', id!==b.dataset.view); }
    if(b.dataset.view==='graph') renderGraph();
  };
});
renderWave(); renderOwner();
</script>
</body>
</html>
`;
}

async function main(): Promise<void> {
  const tasks = readTasks();
  const wave = computeWaves(tasks);
  const critical = computeCriticalPath(tasks);
  let issues = new Map<string, IssueInfo>();
  try {
    issues = await fetchIssues();
  } catch (err) {
    console.warn('拉取 Issue 状态失败（网络/令牌），回退到本地 issue-map.json：', (err as Error).message);
  }
  if (issues.size === 0) issues = readIssueMapFile();
  if (issues.size > 0) {
    const rows = tasks.map((t) => {
      const i = issues.get(t.id);
      return { id: t.id, number: i?.number ?? null, state: i?.state ?? 'open', url: i?.url ?? null };
    });
    writeFileSync(join(planDir, 'issue-map.json'), `${JSON.stringify(rows, null, 2)}\n`);
  }
  const html = buildHtml({ tasks, wave, critical, issues });
  writeFileSync(join(planDir, 'dashboard.html'), html);

  const payload = {
    generatedAt: new Date().toISOString(),
    progress: {
      done: tasks.filter((t) => issues.get(t.id)?.state === 'closed').length,
      total: tasks.length,
    },
    criticalPath: critical.path,
    criticalDays: critical.days,
    waves: Object.fromEntries([...wave.entries()].sort((a, b) => a[1] - b[1])),
  };
  writeFileSync(join(planDir, 'dashboard.json'), `${JSON.stringify(payload, null, 2)}\n`);

  // docs/index.html：GitHub Pages 根路径跳转到看板
  mkdirSync(join(repoRoot, 'docs'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'docs/index.html'),
    '<!doctype html><meta charset="utf-8"><title>AI_RAG 文档</title>' +
      '<meta http-equiv="refresh" content="0; url=./plan/dashboard.html">' +
      '<p>正在打开 <a href="./plan/dashboard.html">任务看板</a>…</p>\n',
  );

  console.log(
    [
      `任务 ${tasks.length} 个，已完成 ${payload.progress.done} 个`,
      `波次 ${Math.max(...[...wave.values()]) + 1} 层；关键路径 ${critical.days} 人日：${critical.path.join(' → ')}`,
      '已生成 docs/plan/dashboard.html、dashboard.json、issue-map.json、docs/index.html',
      issues.size ? `Issue 状态来源：GitHub API（${issues.size} 条）` : 'Issue 状态来源：本地 issue-map.json（未提供 GH_TOKEN）',
    ].join('\n'),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('生成看板失败：', err);
    process.exit(1);
  });
}
