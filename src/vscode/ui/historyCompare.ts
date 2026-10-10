// History compare: run list with two-select, side-by-side metric compare,
// Export JSON. Pure builders.
import type { HistoryEntry } from "../../panels.js";
import { esc, severityPill } from "./html.js";

export interface HistoryCompareVM {
  entries: HistoryEntry[];
  selected: string[];
  compare: { a: HistoryEntry; b: HistoryEntry } | null;
}

export function historyPanelHtml(vm: HistoryCompareVM): string {
  const list = vm.entries.length
    ? [...vm.entries].reverse().map((e) => {
      const sel = vm.selected.includes(e.id);
      return `<div class="file-row" data-act="hist-toggle" data-id="${esc(e.id)}" tabindex="0" aria-current="${sel ? "true" : "false"}">`
        + `${severityPill(e.risk)} <strong>${esc(e.label)}</strong> <span class="muted">${esc(e.at)}</span><br>`
        + `<span class="muted">${e.loc} LOC · ${e.files} files · ${e.decisions} decisions · ${e.pendingCriticalHigh} pending Crit/High</span>`
        + (sel ? ` <span class="pill">selected</span>` : "") + `</div>`;
    }).join("")
    : `<div class="empty"><p>No reviews yet.</p><button class="btn primary" data-act="new-review">New review</button></div>`;
  const cmp = vm.compare
    ? `<h2>Compare</h2><div class="table-scroll"><table class="deci-table"><tr><th></th><th>${esc(vm.compare.a.label)}</th><th>${esc(vm.compare.b.label)}</th></tr>`
      + ([
        ["Risk", vm.compare.a.risk, vm.compare.b.risk],
        ["LOC", String(vm.compare.a.loc), String(vm.compare.b.loc)],
        ["Files", String(vm.compare.a.files), String(vm.compare.b.files)],
        ["Decisions", String(vm.compare.a.decisions), String(vm.compare.b.decisions)],
        ["Pending Crit/High", String(vm.compare.a.pendingCriticalHigh), String(vm.compare.b.pendingCriticalHigh)],
      ] as Array<[string, string, string]>)
        .map(([k, x, y]) => `<tr><td>${k}</td><td>${esc(x)}</td><td>${esc(y)}${x !== y ? " ◀ changed" : ""}</td></tr>`).join("")
      + `</table></div>`
    : (vm.selected.length === 1 ? `<p class="muted">Select one more run to compare.</p>` : "");
  return `<div class="deci-wrap"><p class="deci-label">Deci</p><h1>History</h1>${list}${cmp}`
    + `<div class="row-btns"><button class="btn" data-act="export-history">Export JSON</button></div></div>`;
}

export const HISTORY_CLIENT_JS = [
  "function handleAct(a,e){var act=a.dataset.act;",
  "if(act==='hist-toggle'){post({type:'compareSelect',id:a.dataset.id});return;}",
  "if(act==='export-history'){post({type:'exportHistory'});return;}",
  "if(act==='new-review'){post({type:'newReview'});return;}",
  "}",
  "window.addEventListener('message',function(ev){var m=ev.data||{};if(m.type==='patch'&&m.target==='history'){var sc=window.scrollY;document.body.innerHTML=m.html;window.scrollTo(0,sc);}});",
].join("\n");
