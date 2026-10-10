// Tests panel: verification checklist, discovered/selected tests,
// generate/write/run/diagnose/fix flow with explicit-apply diffs. Pure.
import type { VerifyReport } from "../../verify.js";
import type { TestDiscovery } from "../../discover.js";
import type { TestSelection } from "../../select.js";
import { esc } from "./html.js";

export interface TestRow {
  path: string;
  status: string;
  detail: string;
  output: string;
}

export interface TestsVM {
  verify: VerifyReport | null;
  verifying: boolean;
  discovery: TestDiscovery | null;
  selection: TestSelection | null;
  results: TestRow[];
  generated: Array<{ path: string; added: boolean }>;
  diagnosis: string | null;
  fixDiff: string | null;
  error: string | null;
}

const CHECK_ICON: Record<string, string> = { pass: "✓", fail: "✗", skip: "○", error: "!" };

export function verifyChecklistHtml(report: VerifyReport | null, verifying: boolean): string {
  if (verifying) return `<div class="banner" role="status" aria-live="polite">Verification running…</div>`;
  if (!report) return `<div class="empty"><p>No verification run yet.</p><button class="btn primary" data-act="verify-run">Run verification</button></div>`;
  const rows = report.checks.map((c) =>
    `<div class="check"><span aria-hidden="true">${CHECK_ICON[c.status] ?? "?"}</span><div style="flex:1">`
    + `<strong>${esc(c.label)}</strong> <span class="pill">${esc(c.status)}</span><br><span class="muted">${esc(c.detail)}</span>`
    + (c.output ? `<details><summary>Log</summary><pre class="logbox">${esc(c.output.slice(-4000))}</pre></details>` : "")
    + `</div><button class="btn" data-act="verify-rerun" data-check="${esc(c.id)}">Re-run</button></div>`,
  ).join("");
  return `<p class="muted">${report.passed} passed · ${report.failed} failed · ${report.skipped} skipped</p>${rows}`
    + `<div class="row-btns"><button class="btn primary" data-act="verify-run">Re-run all</button></div>`;
}

export function testsPanelHtml(vm: TestsVM): string {
  const disc = vm.discovery
    ? `<div class="table-scroll"><table class="deci-table"><tr><th>Test</th><th>Framework</th><th>Selected</th><th></th></tr>`
      + vm.discovery.tests.slice(0, 100).map((t) => {
        const sel = vm.selection?.selected.some((s) => s.path === t.path);
        return `<tr><td class="mono">${esc(t.path)}</td><td>${esc(t.framework)}</td><td>${sel ? "✓ for-change" : "—"}</td>`
          + `<td>${t.unrunnable ? esc(t.unrunnable) : `<button class="btn" data-act="test-run" data-path="${esc(t.path)}">Run</button>`}</td></tr>`;
      }).join("") + `</table></div>`
      + (vm.selection?.unselected.length ? `<p class="muted">Not run: ${esc(vm.selection.unselected.map((u) => u.path).join(", "))}</p>` : "")
    : `<div class="empty"><p>No test discovery yet.</p><button class="btn primary" data-act="tests-discover">Discover tests</button></div>`;
  const gen = `<div class="row-btns"><button class="btn" data-act="tests-generate">Generate</button><button class="btn" data-act="tests-write">Write to disk</button><button class="btn primary" data-act="tests-run">Run selected</button><button class="btn" data-act="tests-diagnose">Diagnose failures</button></div>`
    + (vm.results.length ? `<div class="table-scroll"><table class="deci-table"><tr><th>Test</th><th>Status</th><th>Detail</th></tr>`
      + vm.results.map((r) => `<tr><td class="mono">${esc(r.path)}</td><td><span class="pill">${esc(r.status)}</span></td><td>${esc(r.detail)}${r.output ? `<details><summary>Log</summary><pre class="logbox">${esc(r.output.slice(-4000))}</pre></details>` : ""}</td></tr>`).join("")
      + `</table></div>` : "")
    + (vm.generated.length ? `<ul>${vm.generated.map((g) => `<li class="mono">${esc(g.path)}${g.added ? " (new)" : ""}</li>`).join("")}</ul>` : "")
    + (vm.diagnosis ? `<div class="card"><div class="deci-label">Diagnosis</div><p>${esc(vm.diagnosis)}</p></div>` : "")
    + (vm.fixDiff ? `<div class="card"><div class="deci-label">Proposed fix (preview — nothing applied)</div><pre class="logbox">${esc(vm.fixDiff)}</pre><div class="row-btns"><button class="btn primary" data-act="fix-apply">Apply fix</button><button class="btn" data-act="fix-discard">Discard</button></div></div>` : "");
  return `<div class="deci-wrap"><p class="deci-label">Deci</p><h1>Tests &amp; verification</h1>`
    + (vm.error ? `<div class="banner warn" role="alert">${esc(vm.error)}</div>` : "")
    + `<h2>Verification</h2>${verifyChecklistHtml(vm.verify, vm.verifying)}<h2>Change-aware tests</h2>${disc}${gen}</div>`;
}

export const TESTS_CLIENT_JS = [
  "function handleAct(a,e){var act=a.dataset.act;",
  "if(act==='verify-run'){post({type:'rerun'});return;}",
  "if(act==='verify-rerun'){post({type:'rerun',check:a.dataset.check});return;}",
  "if(act==='tests-discover'){post({type:'testsDiscover'});return;}",
  "if(act==='tests-generate'){post({type:'testsGenerate'});return;}",
  "if(act==='tests-write'){if(confirm('Write generated tests to disk?'))post({type:'testsWrite'});return;}",
  "if(act==='tests-run'){post({type:'testsRun'});return;}",
  "if(act==='tests-diagnose'){post({type:'testsDiagnose'});return;}",
  "if(act==='test-run'){post({type:'testsRun',paths:[a.dataset.path]});return;}",
  "if(act==='fix-apply'){if(confirm('Apply the proposed fix?'))post({type:'fixApply',confirmed:true});return;}",
  "if(act==='fix-discard'){post({type:'fixDiscard'});return;}",
  "}",
  "window.addEventListener('message',function(ev){var m=ev.data||{};if(m.type==='patch'&&m.target==='tests'){var sc=window.scrollY;document.body.innerHTML=m.html;window.scrollTo(0,sc);}});",
].join("\n");
