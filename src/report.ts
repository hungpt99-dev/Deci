// Self-contained interactive impact report. Pure: snapshot in, one HTML
// string out. No external assets, no network, vanilla JS — the file works
// from disk (`deci analyze --html report.html`) and inside a VS Code
// webview through the same builder.
//
// Layout: top summary + staleness banner; main diff pane with precise
// line anchors and finding markers; side tabs (Explanation / Impact /
// Risks / Tests); bottom evidence + limitations. Clicking any finding
// scrolls the exact lines into view without leaving review context.

import type { DecisionPoint } from "./decisions.js";
import type { EvidenceBundle } from "./evidence.js";
import type { ImpactMap } from "./impact.js";
import type { ReviewMap } from "./reviewMap.js";
import type { ChangedSymbol } from "./symbols.js";
import { CAPABILITIES } from "./symbols.js";
import type { ChangeOverview } from "./overview.js";
import type { RiskFinding } from "./risks.js";
import type { TestPlan } from "./bundle.js";
import type { TestDiscovery } from "./discover.js";
import type { TestSelection } from "./select.js";
import type { TestResult } from "./run.js";
import type { GeneratedTest } from "./generate.js";
import type { Diagnosis } from "./diagnose.js";

export interface AiSection {
  title: string;
  text: string;
  handledBy: { provider: string; model: string };
  operation: string;
}

export interface RevisionInfo {
  /** Human ref: "working tree", "staged", "main...HEAD", file path… */
  ref: string;
  /** HEAD sha when a git repo resolved it, else null (disclosed, not faked). */
  sha: string | null;
  /** True when the tree was dirty at analysis time (working-tree specs). */
  dirty: boolean;
  analyzedAt: string;
}

export interface AnalysisSnapshot {
  revision: RevisionInfo;
  diffText: string;
  map: ReviewMap;
  queue: DecisionPoint[];
  symbols: ChangedSymbol[];
  impact: ImpactMap;
  risks: RiskFinding[];
  overview: ChangeOverview;
  evidence: EvidenceBundle[];
  testPlan: TestPlan;
  discovery?: TestDiscovery;
  selection?: TestSelection;
  testResults?: TestResult[];
  generated?: GeneratedTest[];
  diagnoses?: Diagnosis[];
  ai?: AiSection[];
}

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** New-file line for added lines (from @@ headers, sequential fallback). */
  newLine: number | null;
}

export interface DiffSection {
  path: string;
  lines: DiffLine[];
}

/** Diff text → per-file renderable sections. Pure; never throws. */
export function diffSections(diffText: string): DiffSection[] {
  const sections: DiffSection[] = [];
  if (!diffText.trim()) return sections;
  let cur: DiffSection | null = null;
  let newLine = -1;
  let fall = 1;
  const flush = (): void => {
    if (cur && (cur.lines.length > 0)) sections.push(cur);
    cur = null;
  };
  const rawLines = diffText.split("\n");
  // Drop the split artifact after a trailing newline (not a content line).
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  for (const raw of rawLines) {
    if (raw.startsWith("diff --git ")) continue;
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("+++ ")) {
      flush();
      const p = raw.slice(4).trim().replace(/^b\//, "");
      cur = { path: p === "/dev/null" ? "(deleted)" : p, lines: [] };
      newLine = -1;
      fall = 1;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      newLine = m ? parseInt(m[1] as string, 10) : -1;
      cur.lines.push({ kind: "hunk", text: raw, newLine: null });
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const n = newLine > 0 ? newLine : fall;
      cur.lines.push({ kind: "add", text: raw.slice(1), newLine: n });
      if (newLine > 0) newLine += 1;
      else fall += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      cur.lines.push({ kind: "del", text: raw.slice(1), newLine: null });
    } else if (raw.startsWith(" ")) {
      cur.lines.push({ kind: "ctx", text: raw.slice(1), newLine: null });
      if (newLine > 0) newLine += 1;
    } else if (raw === "") {
      // Empty line inside a hunk is an empty context line (an added empty
      // line would be "+"). Same accounting as the core parser.
      cur.lines.push({ kind: "ctx", text: "", newLine: null });
      if (newLine > 0) newLine += 1;
    } else if (raw.trim() === "") {
      continue;
    } else {
      cur.lines.push({ kind: "meta", text: raw, newLine: null });
    }
  }
  flush();
  return sections;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const KEYWORDS = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|implements|interface|type|enum|import|from|export|default|async|await|try|catch|finally|throw|public|private|protected|static|readonly|void|null|undefined|true|false|this|super|typeof|instanceof|in|of|package|transient|volatile|synchronized|throws|assert|None|True|False|def|lambda|with|as|pass|raise|elif)\b/g;

/** Tiny tokenizer: comments, strings, keywords, numbers. No dependencies. */
export function highlightLine(code: string): string {
  const src = esc(code);
  const re = /(\/\/[^\n]*|#[^\n]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)/g;
  return src.replace(re, (m, lit, num, word) => {
    if (lit) {
      const cls = lit.startsWith("//") || lit.startsWith("#") ? "c-com" : "c-str";
      return `<span class="${cls}">${lit}</span>`;
    }
    if (num) return `<span class="c-num">${num}</span>`;
    KEYWORDS.lastIndex = 0;
    if (word && KEYWORDS.test(word)) return `<span class="c-kw">${word}</span>`;
    return m;
  });
}

function sevClass(s: string): string {
  return `sev-${s.toLowerCase()}`;
}

export function buildReportHtml(snap: AnalysisSnapshot): string {
  const sections = diffSections(snap.diffText);
  const fileIdx = new Map<string, number>();
  sections.forEach((s, i) => fileIdx.set(s.path, i));

  // Finding markers per (file, line).
  const marks = new Map<string, DecisionPoint[]>();
  for (const d of snap.queue) {
    const key = `${d.file}:${d.line ?? "file"}`;
    const arr = marks.get(key) ?? [];
    arr.push(d);
    marks.set(key, arr);
  }
  const anchorFor = (d: DecisionPoint): string => {
    const i = fileIdx.get(d.file);
    if (i === undefined) return "";
    return d.line ? `L-${i}-${d.line}` : `f-${i}`;
  };

  const css = `
    :root{color-scheme:light dark}
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;font-size:14px;line-height:1.45}
    header{padding:12px 16px;border-bottom:2px solid #888}
    header h1{font-size:17px;margin:0 0 4px}
    .badge{display:inline-block;padding:1px 10px;border-radius:10px;font-weight:600;font-size:12px}
    .sev-critical{background:#fde2e2;color:#8f1d1d}.sev-high{background:#fdeeda;color:#8a4b00}
    .sev-medium{background:#fff3bf;color:#6b5900}.sev-low{background:#e3e3e3;color:#333}
    .stale{margin-top:8px;font-size:12px;opacity:.85}
    .layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:0;align-items:start}
    @media (max-width:900px){.layout{grid-template-columns:1fr}}
    main{padding:8px 12px;min-width:0}
    aside{border-left:1px solid #888;padding:8px 12px;position:sticky;top:0;max-height:100vh;overflow:auto}
    .tabs{display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap}
    .tabs button{padding:4px 10px;cursor:pointer;border:1px solid #888;background:none;border-radius:6px;font-size:13px}
    .tabs button[aria-selected="true"]{font-weight:700;border-width:2px}
    .tabpane{display:none}.tabpane.active{display:block}
    pre.diff{background:#f6f6f6;color:#111;border:1px solid #ccc;border-radius:6px;padding:0;overflow:auto}
    @media (prefers-color-scheme:dark){pre.diff{background:#161616;color:#e8e8e8}}
    .dl{white-space:pre;padding:0 8px 0 44px;position:relative;min-height:1.3em}
    .dl.add{background:rgba(46,160,67,.18)}.dl.del{background:rgba(248,81,73,.16)}
    .dl.hunk{opacity:.75;font-size:12px}.dl.meta{opacity:.6;font-size:12px}
    .ln{position:absolute;left:0;width:36px;text-align:right;opacity:.55;user-select:none;font-size:12px}
    .dl.flash{outline:2px solid #1f6feb;outline-offset:-2px}
    .fmark{cursor:pointer;font-size:12px;margin-left:6px}
    .filehead{font-family:monospace;font-weight:700;padding:8px 8px 4px}
    .risk{border:1px solid #888;border-radius:8px;padding:8px;margin:8px 0;cursor:pointer}
    .risk:hover{border-width:2px}
    .risk h4{margin:0 0 4px;font-size:14px}
    .risk .meta{font-size:12px;opacity:.85}
    .risk .sec{margin:6px 0;font-size:13px}
    .tree{font-size:13px}.tree details{margin:4px 0}.tree summary{cursor:pointer}
    code{background:rgba(127,127,127,.18);padding:0 3px;border-radius:3px;font-size:12.5px}
    .c-kw{color:#cf222e;font-weight:600}.c-str{color:#0a3069}.c-com{color:#59636e;font-style:italic}.c-num{color:#0550ae}
    @media (prefers-color-scheme:dark){.c-kw{color:#ff7b72}.c-str{color:#a5d6ff}.c-com{color:#8b949e}.c-num{color:#79c0ff}}
    footer{padding:12px 16px;border-top:2px solid #888;font-size:13px}
    a{color:#1f6feb}
    .navrow{display:flex;gap:6px;margin:6px 0}
    .navrow button{cursor:pointer}
    .limit{font-size:12.5px;opacity:.9}
  `;

  const js = `
    const findings=[...document.querySelectorAll('[data-target]')];
    let cur=-1;
    function select(el){document.querySelectorAll('.dl.flash').forEach(e=>e.classList.remove('flash'));
      if(!el)return;const t=document.getElementById(el.dataset.target);
      if(t){t.scrollIntoView({block:'center'});t.classList.add('flash');}}
    document.addEventListener('click',e=>{
      const t=e.target.closest('[data-target]');if(!t)return;select(t);
      cur=findings.indexOf(t);});
    document.getElementById('prevF').onclick=()=>{cur=(cur-1+findings.length)%findings.length;select(findings[cur]);};
    document.getElementById('nextF').onclick=()=>{cur=(cur+1)%findings.length;select(findings[cur]);};
    document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
      document.querySelectorAll('.tabs button').forEach(x=>x.setAttribute('aria-selected','false'));
      b.setAttribute('aria-selected','true');
      document.querySelectorAll('.tabpane').forEach(p=>p.classList.toggle('active',p.id==='pane-'+b.dataset.tab));});
  `;

  const rev = snap.revision;
  const riskCls = sevClass(snap.overview.risk);
  const header = `
    <header>
      <h1>Change impact report <span class="badge ${riskCls}">${esc(snap.overview.risk)}</span></h1>
      <div>${esc(snap.overview.riskReason)} ${snap.queue.length} finding(s), ${snap.impact.directFiles.length} direct / ${snap.impact.indirectFiles.length} indirect impacted file(s), ${snap.map.totalLoc} LOC across ${snap.map.fileCount} file(s).</div>
      <div class="stale">Snapshot of <code>${esc(rev.ref)}</code>${rev.sha ? ` @ <code>${esc(rev.sha.slice(0, 12))}</code>` : ""}${rev.dirty ? " (working tree had uncommitted changes)" : ""} · analyzed ${esc(rev.analyzedAt)} · line numbers refer to the analyzed revision · re-run <code>deci analyze</code> after new changes.</div>
    </header>`;

  const diffHtml = sections.map((s, i) => {
    const rows = s.lines.map((l) => {
      const id = l.kind === "add" && l.newLine ? ` id="L-${i}-${l.newLine}"` : "";
      const ln = l.kind === "add" && l.newLine ? `<span class="ln">${l.newLine}</span>` : `<span class="ln"></span>`;
      const key = `${s.path}:${l.kind === "add" && l.newLine ? l.newLine : "file"}`;
      const fm = (l.kind === "add" ? marks.get(key) ?? [] : []);
      const dots = fm.map((d) => `<span class="fmark ${sevClass(d.severity)}" data-target="${anchorFor(d)}" title="${esc(d.findingType)} — ${esc(d.impact)}">● ${esc(d.findingType)}</span>`).join("");
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "ctx" ? " " : "";
      return `<div class="dl ${l.kind}"${id}>${ln}${sign}${highlightLine(l.text)}${dots}</div>`;
    }).join("\n");
    const fileMarks = marks.get(`${s.path}:file`) ?? [];
    const fDots = fileMarks.map((d) => `<span class="fmark ${sevClass(d.severity)}" data-target="${anchorFor(d)}" title="${esc(d.findingType)}">● ${esc(d.findingType)}</span>`).join("");
    return `<div class="filehead" id="f-${i}">${esc(s.path)}${fDots}</div>\n<pre class="diff">${rows}</pre>`;
  }).join("\n");

  const expl = `
    <div class="tabpane active" id="pane-explain">
      <p><strong>Purpose (${snap.overview.purposeSource === "documented" ? "documented requirement" : "inferred — not verified"}):</strong> ${esc(snap.overview.purpose)}</p>
      <h4>Behavioral differences</h4>
      <ul>${snap.overview.behaviors.map((b) => `<li><code>${esc(b.file)}${b.line ? `:${b.line}` : ""}</code>: ${b.before ? `<code>${esc(b.before)}</code> → ` : ""}<code>${esc(b.after)}</code></li>`).join("") || "<li>None.</li>"}</ul>
      <h4>Changed symbols</h4>
      <ul>${snap.overview.affectedSymbols.map((s) => `<li><code>${esc(s.name)}</code> (${s.kind}, ${s.change}) — <code>${esc(s.file)}${s.line ? `:${s.line}` : ""}</code></li>`).join("") || "<li>None detected.</li>"}</ul>
    </div>`;

  const tree = (edges: typeof snap.impact.edges): string => {
    if (edges.length === 0) return `<p>No referencing files in scope.</p>`;
    const bySym = new Map<string, typeof edges>();
    for (const e of edges) {
      const arr = bySym.get(e.symbol) ?? [];
      arr.push(e);
      bySym.set(e.symbol, arr);
    }
    return `<div class="tree">${[...bySym.entries()].map(([sym, arr]) => `
      <details open><summary><code>${esc(sym)}</code> — ${arr.length} file(s)</summary>
      <ul>${arr.map((e) => {
        // Only changed files have diff sections; impacted-only files show
        // as evidence rows (excerpt + evidence class) without navigation.
        const fi = fileIdx.get(e.toFile);
        const where = fi === undefined
          ? `<code>${esc(e.toFile)}:${e.toLine}</code>`
          : `<a href="#f-${fi}" data-target="L-${fi}-${e.toLine}">${esc(e.toFile)}:${e.toLine}</a>`;
        return `<li>${where} (${e.evidence}${e.depth === "indirect" ? `, indirect via ${esc(e.via ?? "")}` : ""}${e.isTest ? ", test" : ""})<br><code>${esc(e.excerpt)}</code></li>`;
      }).join("")}</ul>
      </details>`).join("")}</div>`;
  };

  const impactPane = `
    <div class="tabpane" id="pane-impact">
      <p>${snap.impact.directFiles.length} direct, ${snap.impact.indirectFiles.length} indirect across ${snap.impact.scannedFiles} scanned file(s).</p>
      ${tree(snap.impact.edges)}
      ${snap.impact.unresolved.length ? `<h4>Coverage gaps</h4><ul class="limit">${snap.impact.unresolved.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>` : ""}
    </div>`;

  const risksPane = `
    <div class="tabpane" id="pane-risks">
      <div class="navrow"><button id="prevF">← prev finding</button><button id="nextF">next finding →</button></div>
      ${snap.risks.map((r, n) => `
      <div class="risk" data-target="${anchorFor(snap.queue[n] as DecisionPoint)}">
        <h4><span class="badge ${sevClass(r.severity)}">${r.severity}</span> ${n + 1}. ${esc(r.title)} <span class="meta">[${r.standing}]</span></h4>
        <div class="meta"><code>${esc(r.file)}${r.line ? `:${r.line}` : ""}</code> · claim: ${r.claim} · confidence ${r.confidence.toFixed(2)} — ${esc(r.confidenceMeaning)}</div>
        <div class="sec"><strong>Current:</strong> ${esc(r.current)}</div>
        <div class="sec"><strong>Consequence:</strong> ${esc(r.consequence)}</div>
        <div class="sec"><strong>Failure scenario:</strong> ${esc(r.scenario)}</div>
        <div class="sec"><strong>Mitigation:</strong> ${esc(r.mitigation)}</div>
        <div class="sec"><strong>Suggested test:</strong> ${esc(r.suggestedTest)}</div>
        <div class="sec meta">Evidence: ${r.evidence.map((e) => `<code>${esc(e.label)}:${esc(e.ref)}</code>${e.detail ? ` — <code>${esc(e.detail)}</code>` : ""}`).join(" · ")}</div>
      </div>`).join("") || "<p>No risk findings.</p>"}
    </div>`;

  const discovery = snap.discovery;
  const selection = snap.selection;
  const testResults = snap.testResults ?? [];
  const generated = snap.generated ?? [];
  const diagnoses = snap.diagnoses ?? [];
  const resIcon = { passed: "✓", failed: "✗", skipped: "○", blocked: "!", unexecuted: "–" } as const;
  const diagIdx = new Map<string, number>();
  diagnoses.forEach((d, i) => { if (!diagIdx.has(d.testPath)) diagIdx.set(d.testPath, i); });

  const testsPane = `
    <div class="tabpane" id="pane-tests">
      <h4>Test Explorer (${discovery ? discovery.tests.length : 0} discovered)</h4>
      ${discovery && discovery.tests.length ? `<ul>${discovery.tests.map((t) => `<li><code>${esc(t.path)}</code> — ${t.category}/${t.layer}/${t.framework}${t.command.length ? ` · <code>${esc(t.command.join(" "))}</code>` : ` · unrunnable: ${esc(t.unrunnable ?? "")}`}</li>`).join("")}</ul>` : "<p>No discovery run in this report — use <code>deci tests</code>.</p>"}
      <h4>Change selection (${selection ? selection.selected.length : 0})</h4>
      ${selection && selection.selected.length ? `<ul>${selection.selected.map((t) => `<li><code>${esc(t.path)}</code> [${t.basis}] — ${esc(t.reason)}</li>`).join("")}</ul>` : "<p>None selected.</p>"}
      <h4>Execution Center (${testResults.length} run)</h4>
      ${testResults.length ? `<ul>${testResults.map((r) => {
        const di = diagIdx.get(r.path);
        const label = `${resIcon[r.status]} <code>${esc(r.path)}</code>`;
        const link = di === undefined ? label : `<a href="#dg-${di}" data-target="dg-${di}">${label}</a>`;
        return `<li>${link} — ${r.status}, exit ${r.exitCode ?? "—"}, ${r.durationMs}ms, rev <code>${esc(r.revision)}</code><br>${esc(r.detail)}</li>`;
      }).join("")}</ul>` : "<p>Not executed — run <code>deci analyze --run-tests</code>.</p>"}
      <h4>Plan (static checks)</h4>
      <ul>${snap.testPlan.ran.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      <h4>What to add</h4>
      <ul>${snap.testPlan.toAdd.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      <h4>Impacted tests</h4>
      <ul>${snap.impact.testFiles.map((t) => `<li><code>${esc(t)}</code></li>`).join("") || "<li>None referenced in scope.</li>"}</ul>
    </div>`;

  const genPane = `
    <div class="tabpane" id="pane-generate">
      <h4>Generated tests (${generated.length} — review before keeping)</h4>
      ${generated.map((g, i) => `
      <div class="risk" id="gen-${i}">
        <h4>${i + 1}. <code>${esc(g.path)}</code> → <code>${esc(g.target)}</code></h4>
        <div class="meta">${g.framework} · covers: ${esc(g.covers.join("; "))}</div>
        <details><summary>source (editable after saving — copy into your editor)</summary><pre class="diff">${esc(g.source)}</pre></details>
      </div>`).join("") || "<p>None generated — use <code>--generate-tests</code>.</p>"}
    </div>`;

  const diagPane = `
    <div class="tabpane" id="pane-diagnose">
      <h4>Failure diagnosis (${diagnoses.length})</h4>
      ${diagnoses.map((d, i) => `
      <div class="risk" id="dg-${i}">
        <h4>${i + 1}. <code>${esc(d.testPath)}</code> (exit ${d.exitCode ?? "—"})</h4>
        <div class="sec"><strong>Failure:</strong> ${esc(d.summary)}</div>
        <div class="sec"><strong>Stack:</strong><br>${d.frames.slice(0, 5).map((f) => `<code>${esc(f.path)}${f.line ? `:${f.line}` : ""}</code>${f.fn ? ` — ${esc(f.fn)}` : ""}`).join("<br>") || "(no frames parsed)"}</div>
        <div class="sec"><strong>Causes:</strong><br>${d.causes.map((c) => `[${c.standing}] ${esc(c.statement)}`).join("<br>")}</div>
        ${d.patch ? `<div class="sec"><strong>Proposed patch (NOT applied):</strong> ${esc(d.patch.description)}<pre class="diff">${esc(d.patch.diff)}</pre></div>` : `<div class="sec meta">No mechanical patch recognized — fix must be human-authored.</div>`}
      </div>`).join("") || "<p>No failures diagnosed — run <code>--run-tests --diagnose</code>.</p>"}
    </div>`;

  const endpoints = snap.symbols.filter((s) => s.kind === "endpoint");
  const apiPane = `
    <div class="tabpane" id="pane-api">
      <h4>API Studio — endpoints in this change (${endpoints.length})</h4>
      <p class="limit">Inventory derived from the diff (annotations + route registrations). No live calls are made from this report — copy a curl line into your terminal.</p>
      ${endpoints.map((e) => {
        const route = e.name.startsWith("/") ? e.name : null;
        const curl = route ? `curl -s -X POST "http://localhost:3000${route}" -H 'Content-Type: application/json' -d '{}'` : null;
        return `<div class="risk"><h4><code>${esc(e.name)}</code></h4>
        <div class="meta">${esc(e.file)}${e.line ? `:${e.line}` : ""} · signature: <code>${esc(e.signature)}</code></div>
        ${curl ? `<div class="sec"><strong>Try:</strong> <code>${esc(curl)}</code> (adjust host/port/auth for your service)</div>` : `<div class="sec meta">No route path extracted — check the handler signature above.</div>`}
        </div>`;
      }).join("") || "<p>No endpoint symbols in this change.</p>"}
    </div>`;

  const aiSections = snap.ai ?? [];
  const aiPane = `
    <div class="tabpane" id="pane-ai">
      <h4>AI analysis (${aiSections.length} — generated, verify against evidence)</h4>
      ${aiSections.map((a, i) => `
      <div class="risk" id="ai-${i}">
        <h4>${i + 1}. ${esc(a.title)} <span class="meta">[${esc(a.operation)} · ${esc(a.handledBy.provider)}:${esc(a.handledBy.model)}]</span></h4>
        <div class="sec">${esc(a.text)}</div>
      </div>`).join("") || "<p>No AI sections — run with <code>--ai-explain</code> / <code>--ai-diagnose</code>.</p>"}
    </div>`;

  const footer = `
    <footer>
      <h4>Evidence</h4>
      <ul>${snap.evidence.map((b) => `<li><code>${esc(b.decisionId)}</code> — ${b.present} present / ${b.missing} missing: ${b.items.map((i) => `${i.status === "present" ? "✓" : "✗"} ${esc(i.label)}`).join(", ")}</li>`).join("") || "<li>No decisions — nothing to evidence.</li>"}</ul>
      <h4>Analysis limitations</h4>
      <ul class="limit">
        <li>Symbol and reference discovery is pattern-based (see per-language capabilities below) — re-exports, dynamic calls, and overloads may be missed.</li>
        <li>An edge requires an observed textual reference; filename similarity alone never creates one.</li>
        <li>Risk templates are deterministic heuristics; confidence is a match-strength score, not a failure probability.</li>
        <li>The absence of a finding does not prove the absence of a defect.</li>
        ${snap.overview.unknowns.map((u) => `<li>${esc(u)}</li>`).join("")}
      </ul>
      <h4>Language capabilities</h4>
      <ul class="limit">${CAPABILITIES.map((c) => `<li><code>${esc(c.language)}</code> (${esc(c.paths)}): symbols ${c.symbolParsing}, calls ${c.callReferences}, types ${c.typeRelations}, contracts ${c.contractDiscovery}, tests ${c.testIdentification}, traversal ${c.impactTraversal} — ${esc(c.note)}</li>`).join("")}</ul>
    </footer>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deci change impact report</title>
<style>${css}</style></head>
<body>
${header}
<div class="layout">
<main>${diffHtml || "<p>No changes.</p>"}</main>
<aside>
<div class="tabs" role="tablist">
<button data-tab="explain" aria-selected="true">Explanation</button>
<button data-tab="impact" aria-selected="false">Impact</button>
<button data-tab="risks" aria-selected="false">Risks</button>
<button data-tab="tests" aria-selected="false">Tests</button>
<button data-tab="generate" aria-selected="false">Generate</button>
<button data-tab="diagnose" aria-selected="false">Diagnose</button>
<button data-tab="api" aria-selected="false">API</button>
<button data-tab="ai" aria-selected="false">AI</button>
</div>
${expl}${impactPane}${risksPane}${testsPane}${genPane}${diagPane}${apiPane}${aiPane}
</aside>
</div>
${footer}
<script>${js}</script>
</body>
</html>`;
}
