// Sidebar WebviewView: single "Deci" view with collapsible sections
// (Review, Decisions, Evidence, Alternatives, History, Chat). Pure builders;
// section open-state remembered client-side via getState/setState.
import type { ReviewMap } from "../../reviewMap.js";
import type { DecisionPoint } from "../../decisions.js";
import type { EvidenceBundle } from "../../evidence.js";
import type { AlternativeSet } from "../../alternatives.js";
import type { HistoryEntry } from "../../panels.js";
import type { ConversationMeta } from "../../chat.js";
import { esc, severityPill } from "./html.js";

export interface SidebarVM {
  branch: string;
  map: ReviewMap | null;
  queue: DecisionPoint[];
  evidence: EvidenceBundle[];
  alternatives: AlternativeSet | null;
  history: HistoryEntry[];
  conversations: ConversationMeta[];
  activeConvId: string | null;
}

function section(id: string, title: string, body: string, action?: { act: string; label: string }): string {
  return `<section class="sec" data-sec="${esc(id)}"><button class="sec-head" data-act="toggle-sec" data-sec="${esc(id)}" aria-expanded="true">▾ ${esc(title)}</button>`
    + `<div data-secbody="${esc(id)}">${body}`
    + (action ? `<div class="row-btns"><button class="btn" data-act="${esc(action.act)}">${esc(action.label)}</button></div>` : "")
    + `</div></section>`;
}

export function reviewCardHtml(map: ReviewMap | null): string {
  if (!map || map.files.length === 0) {
    return `<p class="muted">No review yet.</p><div class="row-btns"><button class="btn primary" data-act="new-review">New review</button></div>`;
  }
  const d = map.riskDistribution;
  const tot = Math.max(1, map.files.length);
  const bar = (["Critical", "High", "Medium", "Low", "Verified"] as const)
    .map((s) => {
      const n = d[s]?.files ?? 0;
      if (!n) return "";
      const cls = s === "Verified" ? "Low" : s;
      const col = { Critical: "#ff6b6b", High: "#ffa24d", Medium: "#e8d44d", Low: "#5ec28f" }[cls];
      return `<span style="width:${Math.round((n / tot) * 100)}%;background:${col}" title="${s}: ${n}"></span>`;
    })
    .join("");
  const tiles = [["Files", map.files.length], ["LOC", map.totalLoc], ["Modules", map.modules.length]]
    .map(([k, v]) => `<div class="stat-card"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");
  return `<div class="stat-cards">${tiles}</div><div class="riskbar" role="img" aria-label="Risk distribution">${bar}</div>`
    + `<p class="muted">Critical ${d.Critical?.files ?? 0} · High ${d.High?.files ?? 0} · Medium ${d.Medium?.files ?? 0} · Low ${d.Low?.files ?? 0} · Verified ${d.Verified?.files ?? 0}</p>`
    + `<div class="row-btns"><button class="btn primary" data-act="open-diff">Open Diff Review</button></div>`;
}

export function decisionsRowsHtml(queue: DecisionPoint[]): string {
  if (!queue.length) return `<p class="muted">No decisions — nothing consequential found.</p>`;
  return queue.map((x) =>
    `<div class="file-row" data-act="goto-decision" data-id="${esc(x.id)}" tabindex="0"><span class="dot dot-${esc(x.severity)}"></span>`
    + `<strong>${esc(x.severity)}</strong> ${esc(x.findingType)}<br>`
    + `<span class="muted mono">${esc(x.file)}${x.line ? `:${x.line}` : ""} · ${esc(x.status)}</span>`
    + `<div class="row-btns" data-decidefor="${esc(x.id)}" hidden>`
    + `<button class="btn primary" data-act="decide" data-id="${esc(x.id)}" data-how="accept">Accept</button>`
    + `<button class="btn" data-act="decide" data-id="${esc(x.id)}" data-how="reject">Reject</button>`
    + `<button class="btn" data-act="decide" data-id="${esc(x.id)}" data-how="investigate">Investigate</button></div></div>`,
  ).join("");
}

export function evidenceChipsHtml(bundles: EvidenceBundle[]): string {
  if (!bundles.length) return `<p class="muted">No evidence — run analysis first.</p>`;
  return `<div class="row-btns">${bundles.slice(0, 24).map((b) => `<button class="chip" data-act="open-evidence" data-id="${esc(b.decisionId)}" title="${b.present}/${b.items.length} present">${esc(b.decisionId)} ${b.present}/${b.items.length}</button>`).join("")}</div>`;
}

export function alternativesHtml(set: AlternativeSet | null): string {
  if (!set) return `<p class="muted">No alternatives — reject a decision with a constraint first.</p>`;
  return set.options.map((o) =>
    `<div class="opt-card"><strong>${esc(o.label)}: ${esc(o.title)}</strong><br>`
    + `<span class="muted">${esc(o.complexity)} · ${esc(o.changeSize)} · +${o.locAdded}/-${o.locRemoved}</span>`
    + `<div class="row-btns"><button class="btn primary" data-act="choose-alt" data-dec="${esc(set.decisionId)}" data-opt="${esc(o.id)}">Choose</button></div></div>`,
  ).join("");
}

export function historyListHtml(entries: HistoryEntry[]): string {
  if (!entries.length) return `<p class="muted">No reviews yet.</p>`;
  return [...entries].reverse().map((e) =>
    `<div class="file-row" data-act="open-history" data-id="${esc(e.id)}" tabindex="0">${severityPill(e.risk)} <strong>${esc(e.label)}</strong><br>`
    + `<span class="muted">${e.loc} LOC · ${e.files} files · ${e.decisions} decisions</span></div>`,
  ).join("")
    + `<div class="row-btns"><button class="btn" data-act="compare-runs">Compare runs</button><button class="btn" data-act="export-history">Export JSON</button></div>`;
}

export function chatSectionHtml(convs: ConversationMeta[], activeId: string | null): string {
  const list = convs.length
    ? convs.map((c) => `<div class="file-row" data-act="open-chat" data-id="${esc(c.id)}" tabindex="0">${esc(c.title)} <span class="muted">· ${c.messageCount} msgs${c.id === activeId ? " · active" : ""}</span></div>`).join("")
    : `<p class="muted">No conversations yet.</p>`;
  return list + `<div class="row-btns"><button class="btn primary" data-act="new-chat">New chat</button></div>`;
}

export function buildSidebarHtml(vm: SidebarVM): string {
  return `<div class="deci-side"><header style="display:flex;gap:8px;align-items:center;padding:8px 4px">`
    + `<strong>Deci</strong><span class="chip" title="Branch">${esc(vm.branch || "no repo")}</span>`
    + `<span style="flex:1"></span><button class="btn" data-act="rerun" aria-label="Re-run analysis">Re-run</button></header>`
    + section("review", "Review", reviewCardHtml(vm.map))
    + section("decisions", `Decisions (${vm.queue.length})`, decisionsRowsHtml(vm.queue), { act: "open-decisions", label: "Open Decisions panel" })
    + section("evidence", "Evidence", evidenceChipsHtml(vm.evidence))
    + section("alternatives", "Alternatives", alternativesHtml(vm.alternatives))
    + section("history", "History", historyListHtml(vm.history))
    + section("chat", "Chat", chatSectionHtml(vm.conversations, vm.activeConvId))
    + `</div>`;
}

export const SIDEBAR_CLIENT_JS = [
  "function st(){try{return vscode.getState()||{};}catch(e){return {};}}",
  "function sv(s){try{vscode.setState(s);}catch(e){}}",
  "function handleAct(a,e){var act=a.dataset.act;",
  "if(act==='toggle-sec'){var id=a.dataset.sec;var open=a.getAttribute('aria-expanded')==='true';a.setAttribute('aria-expanded',open?'false':'true');a.textContent=(open?'▸ ':'▾ ')+a.textContent.slice(2);var b=document.querySelector('[data-secbody=\"'+id+'\"]');if(b)b.hidden=open;var s=st();s['sec_'+id]=!open;sv(s);return;}",
  "if(act==='new-review'){post({type:'newReview'});return;}",
  "if(act==='open-diff'){post({type:'openDiff'});return;}",
  "if(act==='goto-decision'){var box=a.querySelector('[data-decidefor]');if(box)box.hidden=!box.hidden;post({type:'gotoDecision',id:a.dataset.id});return;}",
  "if(act==='decide'){e.stopPropagation();post({type:'decision',id:a.dataset.id,action:a.dataset.how});return;}",
  "if(act==='open-evidence'){post({type:'openEvidence',id:a.dataset.id});return;}",
  "if(act==='choose-alt'){post({type:'chooseAlternative',decisionId:a.dataset.dec,optionId:a.dataset.opt});return;}",
  "if(act==='open-history'){post({type:'openHistory',id:a.dataset.id});return;}",
  "if(act==='compare-runs'){post({type:'compareRuns'});return;}",
  "if(act==='export-history'){post({type:'exportHistory'});return;}",
  "if(act==='open-chat'){post({type:'openChat',id:a.dataset.id});return;}",
  "if(act==='new-chat'){post({type:'newChat'});return;}",
  "if(act==='rerun'){post({type:'rerun'});return;}",
  "if(act==='open-decisions'){post({type:'openDecisions'});return;}",
  "}",
  "(function(){var s=st();document.querySelectorAll('[data-sec]').forEach(function(sec){var id=sec.dataset.sec;if(s['sec_'+id]===false){var h=sec.querySelector('.sec-head');if(h){h.setAttribute('aria-expanded','false');h.textContent='▸ '+h.textContent.slice(2);}var b=sec.querySelector('[data-secbody]');if(b)b.hidden=true;}});})();",
  "window.addEventListener('message',function(ev){var m=ev.data||{};if(m.type==='patch'&&m.target==='sidebar'){var sc=document.body.scrollTop;document.querySelector('.deci-side').outerHTML=m.html;document.body.scrollTop=sc;}});",
].join("\n");
