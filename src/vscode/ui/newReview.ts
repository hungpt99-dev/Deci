// "New review" screen: segmented source picker, branch/range, ticket/doc
// file fields, analysis options, Run. Pure builders + client collector.
import { esc } from "./html.js";

export interface NewReviewVM {
  hasGit: boolean;
  branches: string[];
  defaultBranch: string;
  verify: boolean;
  staticOnly: boolean;
  genTests: boolean;
  runTests: boolean;
  diagnose: boolean;
  aiExplain: boolean;
  busy: boolean;
  error: string | null;
}

export function buildNewReviewHtml(vm: NewReviewVM): string {
  const check = (key: string, label: string, on: boolean) =>
    `<label class="f"><span><input type="checkbox" data-opt="${key}"${on ? " checked" : ""}${vm.busy ? " disabled" : ""}> ${esc(label)}</span></label>`;
  return `<div class="deci-wrap"><p class="deci-label">Deci</p><h1>New review</h1>`
    + (vm.error ? `<div class="banner warn" role="alert">${esc(vm.error)}</div>` : "")
    + `<h2>What to analyze</h2><div class="card" role="radiogroup" aria-label="Diff source">`
    + `<label class="f"><span><input type="radio" name="src" value="working"${vm.hasGit ? " checked" : ""}${vm.hasGit ? "" : " disabled"}> Working tree <span class="muted">git diff HEAD</span></span></label>`
    + `<label class="f"><span><input type="radio" name="src" value="staged"${vm.hasGit ? "" : " disabled"}> Staged <span class="muted">git diff --staged</span></span></label>`
    + `<div><label class="f"><span><input type="radio" name="src" value="range"> Branch range</span></label>`
    + `<div style="display:flex;gap:8px"><select data-range-base aria-label="Base branch">${vm.branches.map((b) => `<option${b === vm.defaultBranch ? " selected" : ""}>${esc(b)}</option>`).join("")}</select>`
    + `<input type="text" data-range-head value="HEAD" aria-label="Head ref"></div></div>`
    + `<div><label class="f"><span><input type="radio" name="src" value="file"> Single file</span></label>`
    + `<input type="text" data-file-path placeholder="path/to/file.ts" aria-label="File path"></div>`
    + `</div><h2>Context (optional)</h2><div class="card">`
    + `<label class="f">Ticket ref or path<input type="text" data-ticket placeholder="PROJ-123 or ./ticket.md"></label>`
    + `<label class="f">Design doc ref or path<input type="text" data-doc placeholder="./docs/adr-004.md"></label></div>`
    + `<h2>Options</h2><div class="card">`
    + check("verify", "Run verification (build, tests, lint, format, schema, deps)", vm.verify)
    + check("staticOnly", "Static-only — no command execution", vm.staticOnly)
    + check("genTests", "Generate tests for gaps", vm.genTests)
    + check("runTests", "Run discovered tests", vm.runTests)
    + check("diagnose", "Diagnose failures (needs run)", vm.diagnose)
    + check("aiExplain", "AI explain (explicit; local free, cloud gated)", vm.aiExplain)
    + `</div><div class="row-btns"><button class="btn primary" data-act="run-review"${vm.busy ? " disabled" : ""}>${vm.busy ? "Analyzing…" : "Run review"}</button></div>`
    + (vm.busy ? `<div class="banner" role="status" aria-live="polite">Analysis running — this panel updates when done.</div>` : "")
    + `</div>`;
}

export const NEW_REVIEW_CLIENT_JS = [
  "function handleAct(a,e){var act=a.dataset.act;",
  "if(act==='run-review'){var src=(document.querySelector('input[name=src]:checked')||{}).value||'working';var o={};document.querySelectorAll('[data-opt]').forEach(function(c){o[c.dataset.opt]=c.checked;});var base=document.querySelector('[data-range-base]');var head=document.querySelector('[data-range-head]');var fp=document.querySelector('[data-file-path]');var tk=document.querySelector('[data-ticket]');var dc=document.querySelector('[data-doc]');post({type:'runAnalysis',source:src,base:base?base.value:null,head:head?head.value:null,file:fp?fp.value:null,ticket:tk?tk.value:null,doc:dc?dc.value:null,options:o});return;}",
  "}",
].join("\n");
