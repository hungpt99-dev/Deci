// Diff Review panel: 3-column code-change review with line-anchored
// findings and note threads. Pure builders (view model in, HTML out);
// interactive behavior arrives via postMessage (see DIFF_REVIEW_CLIENT_JS).
import type { FileChange } from "../../reviewMap.js";
import type { DecisionPoint } from "../../decisions.js";
import type { EvidenceBundle } from "../../evidence.js";
import type { ImpactMap } from "../../impact.js";
import type { TestDiscovery } from "../../discover.js";
import type { TestSelection } from "../../select.js";
import type { TestPlan, RollbackPlan } from "../../bundle.js";
import { anchorLine, type FileDiff } from "./diffModel.js";
import { banner, emptyState, esc, severityPill } from "./html.js";

export interface NoteItem {
  id: string;
  author: "You" | "Deci";
  text: string;
  at: string;
  resolved: boolean;
}

export interface FindingVM {
  decision: DecisionPoint;
  evidencePresent: string;
  notes: NoteItem[];
}

export type SeverityFilter = "Critical" | "High" | "Medium" | "Low";

export interface DiffReviewVM {
  rev: string;
  files: FileDiff[];
  fileMeta: Map<string, FileChange>;
  findings: FindingVM[];
  evidence: EvidenceBundle[];
  impact: ImpactMap | null;
  discovery: TestDiscovery | null;
  selection: TestSelection | null;
  testPlan: TestPlan | null;
  rollbackPlan: RollbackPlan | null;
  expandedFile: string | null;
  view: "unified" | "split";
  stale: boolean;
  aiCard: string | null;
}

const SEV_ORDER: SeverityFilter[] = ["Critical", "High", "Medium", "Low"];
const SEV_LETTER: Record<string, string> = { Critical: "C", High: "H", Medium: "M", Low: "L" };

export function riskOf(vm: DiffReviewVM, path: string): string {
  return vm.fileMeta.get(path)?.risk ?? "Medium";
}

export function findingsForLine(vm: DiffReviewVM, path: string, newLine: number | null): FindingVM[] {
  if (newLine === null) return [];
  return vm.findings.filter(
    (f) => f.decision.file === path && anchorLine(f.decision.line) === newLine,
  );
}

/** Small built-in tokenizer: single pass so keywords never match inside strings/comments. */
const TOK_RE = new RegExp(
  "(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|(&quot;.*?&quot;|&#39;.*?&#39;|`[^`]*?`)"
  + "|\\b(const|let|var|function|return|if|else|for|while|import|export|from|class|interface|type|new|await|async|try|catch|throw|switch|case|break|continue|typeof|instanceof|in|of|do|null|undefined|true|false|this|super|extends|implements|enum|public|private|protected|static|readonly|def|lambda|pass|raise|with|as|elif|None|struct|fn|mut|match|loop|impl|trait|where|use|mod|pub|package|func|go|defer|select|chan|map)\\b"
  + "|(\\d[\\d._]*)",
  "g",
);

export function highlight(text: string): string {
  return esc(text).replace(
    TOK_RE,
    (m: string, c: string | undefined, s: string | undefined, k: string | undefined, n: string | undefined) => {
      void m;
      if (c !== undefined) return `<span class="tok-c">${c}</span>`;
      if (s !== undefined) return `<span class="tok-s">${s}</span>`;
      if (k !== undefined) return `<span class="tok-k">${k}</span>`;
      return `<span class="tok-n">${n}</span>`;
    },
  );
}

function gutterMarker(sev: string): string {
  return `<span class="mk mk-${esc(sev)}" title="${esc(sev)}" aria-hidden="true">${SEV_LETTER[sev] ?? "?"}</span>`;
}

export function noteThreadHtml(f: FindingVM, file: string, line: number): string {
  const open = f.notes.filter((n) => !n.resolved);
  const notes = f.notes
    .map(
      (n) =>
        `<div class="note" data-note="${esc(n.id)}"><div class="who">${esc(n.author)} · ${esc(n.at)}${n.resolved ? " · resolved" : ""}${n.author === "Deci" ? " · AI" : ""}</div>`
        + `<div class="txt">${esc(n.text)}</div>`
        + `<div class="row-btns"><button class="btn" data-act="note-resolve" data-id="${esc(n.id)}" data-finding="${esc(f.decision.id)}">${n.resolved ? "Reopen" : "Resolve"}</button>`
        + `<button class="btn" data-act="note-delete" data-id="${esc(n.id)}" data-finding="${esc(f.decision.id)}">Delete</button></div></div>`,
    )
    .join("");
  return `<div class="note-thread" data-notes-for="${esc(f.decision.id)}">`
    + `<div class="deci-label">Notes${open.length ? ` (${open.length} open)` : ""} · ${esc(file)}:${line}</div>`
    + (notes || `<p class="muted">No notes yet.</p>`)
    + `<div class="row-btns"><button class="btn" data-act="note-add" data-finding="${esc(f.decision.id)}" data-file="${esc(file)}" data-line="${line}">Add note</button></div></div>`;
}

export function findingCardHtml(f: FindingVM): string {
  const d = f.decision;
  const line = anchorLine(d.line);
  return `<article class="finding f-${esc(d.severity)}" data-finding="${esc(d.id)}" data-sev="${esc(d.severity)}" data-file="${esc(d.file)}"${line !== null ? ` data-line="${line}"` : ""} tabindex="0" aria-label="${esc(d.severity)} finding ${esc(d.findingType)}">`
    + `<div>${severityPill(d.severity)} <strong>${esc(d.findingType)}</strong> `
    + `<span class="mono muted">${esc(d.file)}${line !== null ? `:${line}` : ""}</span> `
    + `<span class="muted">· ${d.uncertain ? "hypothesis" : d.confidence < 0.6 ? "potential" : "confirmed"} · conf ${d.confidence.toFixed(2)}</span></div>`
    + `<p>${esc(d.impact)}</p>`
    + (d.before || d.after
      ? `<details><summary>Before / after</summary><pre class="logbox">${esc(d.before)}${d.before && d.after ? "\n---\n" : ""}${esc(d.after)}</pre></details>`
      : "")
    + (d.unknowns?.length ? `<p class="muted">Open: ${esc(d.unknowns.join("; "))}</p>` : "")
    + `<div class="muted">Evidence: ${esc(f.evidencePresent)}${f.notes.length ? ` · ${f.notes.length} note${f.notes.length === 1 ? "" : "s"}` : ""} · ${esc(d.status)}</div>`
    + `<div class="row-btns" role="group" aria-label="Decision actions">`
    + `<button class="btn primary" data-act="decide" data-id="${esc(d.id)}" data-how="accept">Accept (a)</button>`
    + `<button class="btn" data-act="decide" data-id="${esc(d.id)}" data-how="reject">Reject (r)</button>`
    + `<button class="btn" data-act="decide" data-id="${esc(d.id)}" data-how="investigate">Investigate (i)</button>`
    + `<button class="btn" data-act="open-file" data-path="${esc(d.file)}" data-line="${line ?? ""}">Open (o)</button>`
    + `</div></article>`;
}

export function fileTreeHtml(vm: DiffReviewVM): string {
  const byModule = new Map<string, FileDiff[]>();
  for (const f of vm.files) {
    const mod = vm.fileMeta.get(f.path)?.module ?? "(root)";
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)?.push(f);
  }
  const chips = [...SEV_ORDER.map((s) => `<button class="chip" data-act="filter-sev" data-sev="${s}" aria-pressed="false">${s}</button>`),
    `<button class="chip" data-act="filter-notes" aria-pressed="false">Has notes</button>`,
    `<button class="chip" data-act="filter-undecided" aria-pressed="false">Undecided</button>`].join("");
  const groups = [...byModule.entries()]
    .map(([mod, files]) => {
      const rows = files
        .map((f) => {
          const meta = vm.fileMeta.get(f.path);
          const sev = meta?.risk ?? "Medium";
          const n = vm.findings.filter((x) => x.decision.file === f.path).length;
          const verified = sev === "Verified" || (sev === "Low" && n === 0);
          return `<div class="file-row" role="treeitem" tabindex="0" data-act="open-diff-file" data-path="${esc(f.path)}" data-verified="${verified ? "1" : ""}" data-sev="${esc(sev)}" aria-current="${vm.expandedFile === f.path ? "true" : "false"}">`
            + `<span class="dot dot-${esc(sev)}" title="${esc(sev)}"></span>`
            + `<span class="mono">${esc(f.path.split("/").pop() ?? f.path)}</span><br>`
            + `<span class="muted mono">+${f.added}/-${f.removed}${n ? ` · ${n} finding${n === 1 ? "" : "s"}` : ""}</span></div>`;
        })
        .join("");
      return `<div class="sec"><button class="sec-head" data-act="toggle-mod" aria-expanded="true">${esc(mod)}</button><div data-mod="${esc(mod)}">${rows}</div></div>`;
    })
    .join("");
  return `<div class="dr-left"><div class="deci-label">Files (${vm.files.length})</div>`
    + `<div class="row-btns" role="toolbar" aria-label="Filters">${chips}</div>`
    + `<div class="row-btns"><button class="btn" data-act="view-toggle">Unified ⇄ Split (u)</button></div>`
    + groups + `</div>`;
}

function diffLineHtml(kind: string, oldLn: number | null, newLn: number | null, text: string, marker: string, fid: string, file: string): string {
  const cls = kind === "add" ? "dline add" : kind === "del" ? "dline del" : "dline";
  const ln = kind === "del" ? (oldLn ?? "") : (newLn ?? "");
  return `<div class="${cls}" data-nl="${newLn ?? ""}">`
    + `<span class="gutter" data-act="line-note" data-finding="${esc(fid)}" data-file="${esc(file)}" data-line="${newLn ?? ""}" title="Add note">${marker}</span>`
    + `<span class="ln">${ln}</span><span class="tx">${highlight(text)}</span></div>`;
}

export function diffFileHtml(vm: DiffReviewVM, file: FileDiff, bodyOnly: boolean): string {
  if (vm.view === "split") return splitFileHtml(vm, file, bodyOnly);
  const parts: string[] = [];
  if (!bodyOnly) parts.push(`<h3 class="mono">${esc(file.path)}</h3>`);
  for (const h of file.hunks) {
    parts.push(`<div class="dline hunk"><span class="gutter"></span><span class="ln">···</span><span class="tx">@@ ${h.oldStart} → ${h.newStart}</span></div>`);
    for (const l of h.lines) {
      const marks = findingsForLine(vm, file.path, l.newLine);
      const marker = marks.length ? gutterMarker(marks[0]?.decision.severity ?? "Medium") : "+";
      const fid = marks[0]?.decision.id ?? "";
      parts.push(diffLineHtml(l.kind, l.oldLine, l.newLine, l.text, marker, fid, file.path));
      for (const m of marks) {
        parts.push(findingCardHtml(m));
        if (l.newLine !== null) parts.push(noteThreadHtml(m, file.path, l.newLine));
      }
    }
  }
  return parts.join("");
}

/** Split view: left = old (context+del), right = new (context+add). Findings hang off new lines. */
export function splitFileHtml(vm: DiffReviewVM, file: FileDiff, bodyOnly: boolean): string {
  const parts: string[] = [];
  if (!bodyOnly) parts.push(`<h3 class="mono">${esc(file.path)}</h3>`);
  parts.push(`<div class="diff-grid">`);
  for (const side of ["old", "new"] as const) {
    const rows: string[] = [];
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (side === "old" && l.kind === "add") continue;
        if (side === "new" && l.kind === "del") continue;
        const ln = side === "old" ? l.oldLine : l.newLine;
        const cls = l.kind === "add" ? "dline add" : l.kind === "del" ? "dline del" : "dline";
        rows.push(`<div class="${cls}"><span class="gutter"></span><span class="ln">${ln ?? ""}</span><span class="tx">${highlight(l.text)}</span></div>`);
      }
    }
    parts.push(`<div class="diff-pane" aria-label="${side} side">${rows.join("")}</div>`);
  }
  parts.push(`</div>`);
  for (const h of file.hunks) {
    for (const l of h.lines) {
      for (const m of findingsForLine(vm, file.path, l.newLine)) {
        parts.push(findingCardHtml(m));
        if (l.newLine !== null) parts.push(noteThreadHtml(m, file.path, l.newLine));
      }
    }
  }
  return parts.join("");
}

export function rightTabsHtml(vm: DiffReviewVM): string {
  const ranked = [...vm.findings].sort(
    (a, b) => SEV_ORDER.indexOf(a.decision.severity as SeverityFilter) - SEV_ORDER.indexOf(b.decision.severity as SeverityFilter),
  );
  const findings = ranked.length
    ? ranked.map((f) => {
      const d = f.decision;
      const line = anchorLine(d.line);
      return `<div class="frow file-row" data-act="goto-finding" data-id="${esc(d.id)}" data-file="${esc(d.file)}" data-line="${line ?? ""}" tabindex="0">${severityPill(d.severity)}<span> ${esc(d.findingType)}</span> <span class="muted mono">${esc(d.file)}${line !== null ? `:${line}` : ""}${f.notes.length ? ` · ${f.notes.length} note${f.notes.length === 1 ? "" : "s"}` : ""}</span></div>`;
    }).join("")
    : `<p class="muted">No findings.</p>`;
  const evidence = vm.evidence.length
    ? vm.evidence.map((b) => `<div class="frow file-row" data-act="open-evidence" data-id="${esc(b.decisionId)}" tabindex="0"><span class="mono">${esc(b.decisionId)}</span> <span class="muted">${b.present}/${b.items.length} present</span></div>`).join("")
    : `<p class="muted">No evidence bundles.</p>`;
  const impact = vm.impact
    ? (vm.impact.edges.slice(0, 50).map((e: { symbol: string; toFile: string; toLine: number; evidence: string }) => `<div class="frow file-row" data-act="open-file" data-path="${esc(e.toFile)}" data-line="${e.toLine}" tabindex="0"><span class="mono">${esc(e.symbol)}</span> <span class="muted">→ ${esc(e.toFile)}:${e.toLine} (${esc(e.evidence)})</span></div>`).join("") || `<p class="muted">No impacted references.</p>`)
    : `<p class="muted">Impact not computed for this review.</p>`;
  const tests = vm.discovery
    ? `<p class="muted">${vm.discovery.tests.length} discovered${vm.selection ? ` · ${vm.selection.selected.length} selected` : ""}</p>`
      + (vm.selection?.selected ?? []).slice(0, 30).map((t: { path: string; reason: string }) => `<div class="frow"><span class="mono">${esc(t.path)}</span> <span class="muted">${esc(t.reason)}</span></div>`).join("")
      + `<div class="row-btns"><button class="btn primary" data-act="open-tests">Open Tests panel</button></div>`
    : `<div class="empty"><p>No test discovery yet.</p><button class="btn" data-act="open-tests">Open Tests panel</button></div>`;
  const plan = vm.testPlan || vm.rollbackPlan
    ? `${vm.testPlan ? `<div class="deci-label">Test plan</div><ul>${vm.testPlan.toAdd.map((s: string) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}`
      + `${vm.rollbackPlan ? `<div class="deci-label">Rollback plan</div><ol>${vm.rollbackPlan.steps.map((s: string) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}`
      + `<div class="row-btns"><button class="btn" data-act="copy-plan">Copy</button><button class="btn" data-act="export-plan">Export</button></div>`
    : `<p class="muted">No plan for this review.</p>`;
  return `<div class="dr-right"><div class="tabs" role="tablist">`
    + ["Findings", "Evidence", "Impact", "Tests", "Plan"].map((t, i) => `<button role="tab" data-act="tab" data-tab="${t}" aria-selected="${i === 0 ? "true" : "false"}">${t}</button>`).join("")
    + `</div><div data-tabpane="Findings">${findings}</div><div data-tabpane="Evidence" hidden>${evidence}</div>`
    + `<div data-tabpane="Impact" hidden>${impact}</div><div data-tabpane="Tests" hidden>${tests}</div>`
    + `<div data-tabpane="Plan" hidden>${plan}</div></div>`;
}

export function buildDiffReviewHtml(vm: DiffReviewVM): string {
  const head = `<div class="deci-label">Diff Review · revision <span class="mono">${esc(vm.rev.slice(0, 12))}</span></div>`
    + (vm.stale ? banner(`Line numbers refer to revision ${vm.rev.slice(0, 12)}. Re-run after new changes.`, true) : "");
  if (vm.files.length === 0) {
    return head + emptyState("No changes", "This diff is empty. Choose what to review to start.", { id: "new-review", label: "Choose what to review" });
  }
  const first = vm.expandedFile ?? vm.files[0]?.path ?? "";
  const center = `<div class="dr-center" id="drCenter" tabindex="0" aria-label="Diff">`
    + (vm.aiCard ? `<div class="card"><div class="deci-label">AI explanation</div><pre class="logbox">${esc(vm.aiCard.slice(0, 4000))}</pre></div>` : "")
    + `<div class="row-btns"><button class="btn" data-act="prev-finding">← Prev (k)</button><button class="btn" data-act="next-finding">Next (j) →</button></div>`
    + `<div id="drFile">${first ? diffFileHtml(vm, vm.files.find((f) => f.path === first) ?? vm.files[0]!, false) : ""}</div></div>`;
  return head + `<div class="dr">${fileTreeHtml(vm)}${center}${rightTabsHtml(vm)}</div>`;
}

export const DIFF_REVIEW_CLIENT_JS = [
  "function cur(){try{return window.__DECI_STATE__||{};}catch(e){return {};}}",
  "function handleAct(a,e){var act=a.dataset.act;",
  "if(act==='tab'){var root=a.closest('.dr-right');root.querySelectorAll('[role=tab]').forEach(function(t){t.setAttribute('aria-selected',t===a?'true':'false');});root.querySelectorAll('[data-tabpane]').forEach(function(p){p.hidden=p.dataset.tabpane!==a.dataset.tab;});return;}",
  "if(act==='open-diff-file'){post({type:'expandFile',path:a.dataset.path});return;}",
  "if(act==='view-toggle'){post({type:'view',view:cur().view==='split'?'unified':'split'});return;}",
  "if(act==='filter-sev'){var on=a.getAttribute('aria-pressed')==='true';a.setAttribute('aria-pressed',on?'false':'true');applyFilters();return;}",
  "if(act==='filter-notes'||act==='filter-undecided'){var on2=a.getAttribute('aria-pressed')==='true';a.setAttribute('aria-pressed',on2?'false':'true');applyFilters();return;}",
  "if(act==='goto-finding'){scrollToFinding(a.dataset.id);return;}",
  "if(act==='prev-finding'){stepFinding(-1);return;}",
  "if(act==='next-finding'){stepFinding(1);return;}",
  "if(act==='decide'){post({type:'decision',id:a.dataset.id,action:a.dataset.how});return;}",
  "if(act==='open-file'){post({type:'openFile',path:a.dataset.path||'',line:a.dataset.line||''});return;}",
  "if(act==='line-note'||act==='note-add'){openComposer(a.dataset.finding||'',a.dataset.file||'',a.dataset.line||'');return;}",
  "if(act==='note-resolve'){post({type:'note',op:'resolve',id:a.dataset.id,findingId:a.dataset.finding});return;}",
  "if(act==='note-delete'){if(confirm('Delete this note?'))post({type:'note',op:'delete',id:a.dataset.id,findingId:a.dataset.finding});return;}",
  "if(act==='open-tests'){post({type:'openTests'});return;}",
  "if(act==='open-evidence'){post({type:'openEvidence',id:a.dataset.id});return;}",
  "if(act==='copy-plan'){var p=document.querySelector('[data-tabpane=Plan]');if(p&&navigator.clipboard)navigator.clipboard.writeText(p.innerText);return;}",
  "if(act==='export-plan'){post({type:'exportPlan'});return;}",
  "if(act==='new-review'){post({type:'newReview'});return;}",
  "if(act==='toggle-mod'){var open=a.getAttribute('aria-expanded')==='true';a.setAttribute('aria-expanded',open?'false':'true');var sib=a.nextElementSibling;if(sib)sib.hidden=open;return;}",
  "}",
  "function allFindings(){return Array.prototype.slice.call(document.querySelectorAll('.finding[data-line]'));}",
  "function scrollToFinding(id){var el=document.querySelector('.finding[data-finding=\"'+id+'\"]');if(!el)return;el.scrollIntoView({block:'center'});el.focus({preventScroll:true});}",
  "var fIdx=-1;",
  "function stepFinding(d){var els=allFindings();if(!els.length)return;fIdx=(fIdx+d+els.length)%els.length;var el=els[fIdx];el.scrollIntoView({block:'center'});el.focus({preventScroll:true});}",
  "function applyFilters(){var sevs={};document.querySelectorAll('[data-act=filter-sev]').forEach(function(c){if(c.getAttribute('aria-pressed')==='true')sevs[c.dataset.sev]=1;});var needNotes=document.querySelector('[data-act=filter-notes]').getAttribute('aria-pressed')==='true';var needUnd=document.querySelector('[data-act=filter-undecided]').getAttribute('aria-pressed')==='true';var anySev=Object.keys(sevs).length>0;document.querySelectorAll('.finding').forEach(function(f){var ok=true;if(anySev&&!sevs[f.dataset.sev])ok=false;f.style.display=ok?'':'none';var th=f.nextElementSibling;if(th&&th.classList&&th.classList.contains('note-thread'))th.style.display=ok?'':'none';});}",
  "function openComposer(fid,file,line){var host=document.querySelector('.finding[data-finding=\"'+fid+'\"]');var box=document.createElement('div');box.className='note-thread';box.innerHTML='<div class=\"deci-label\">New note · '+file+':'+line+'</div><textarea rows=\"3\" style=\"width:100%\" aria-label=\"Note text\"></textarea><div class=\"row-btns\"><button class=\"btn primary\" data-save=\"1\">Save note (n)</button><button class=\"btn\" data-cancel=\"1\">Cancel</button></div>';(host||document.getElementById('drFile')).appendChild(box);var ta=box.querySelector('textarea');ta.focus();box.querySelector('[data-save]').addEventListener('click',function(){var t=ta.value.trim();if(!t)return;post({type:'note',op:'add',findingId:fid,file:file,line:line?parseInt(line,10):null,text:t});box.remove();});box.querySelector('[data-cancel]').addEventListener('click',function(){box.remove();});}",
  "document.addEventListener('keydown',function(e){var tag=(document.activeElement&&document.activeElement.tagName)||'';if(tag==='TEXTAREA'||tag==='INPUT')return;if(e.key==='j'){stepFinding(1);}else if(e.key==='k'){stepFinding(-1);}else if(e.key==='u'){post({type:'view',view:cur().view==='split'?'unified':'split'});}});",
  "window.addEventListener('message',function(ev){var m=ev.data||{};if(m.type==='patch'&&m.target==='drFile'){var el=document.getElementById('drFile');if(!el)return;var sc=el.parentElement.scrollTop;el.innerHTML=m.html;el.parentElement.scrollTop=sc;}});",
].join("\n");
