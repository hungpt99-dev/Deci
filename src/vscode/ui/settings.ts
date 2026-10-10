// Settings panel: provider cards (9 registry providers), per-operation
// routing, fallback order, privacy toggles, analysis/testing defaults.
// Secrets shown as set/missing only — values never rendered. Pure builders.
import type { ProviderSpec, DeciOperation } from "../../providers.js";
import { esc } from "./html.js";

export interface ProviderSettings {
  spec: ProviderSpec;
  baseURL: string;
  model: string;
  keySet: boolean;
  envOverridden: string[];
}

export interface SettingsVM {
  providers: ProviderSettings[];
  activeProvider: string;
  routing: Record<string, string>;
  fallback: string[];
  allowCloudAi: boolean;
  allowCloudFallback: boolean;
  verify: boolean;
  staticOnly: boolean;
  testTimeoutMs: number;
  dirty: boolean;
}

export const ROUTED_OPS: DeciOperation[] = ["explain", "impact", "test-plan", "test-gen", "diagnose", "fix"];

export function providerCardHtml(p: ProviderSettings, active: boolean): string {
  const s = p.spec;
  const env = p.envOverridden.length ? ` <span class="chip" title="Environment wins">overridden by env: ${esc(p.envOverridden.join(", "))}</span>` : "";
  return `<div class="opt-card${active ? " rec" : ""}" data-provider="${esc(s.id)}">`
    + `<strong>${esc(s.label)}</strong> `
    + `<span class="pill ${s.local ? "pill-Low" : "pill-Medium"}">${s.local ? "Local" : "Cloud"}</span> `
    + (s.needsKey ? (p.keySet ? `<span class="pill pill-Low">key: set</span>` : `<span class="pill pill-High">key: missing</span>`) : `<span class="pill pill-Low">key: none needed</span>`)
    + `${env}<br><span class="muted">${esc(s.notes)}</span>`
    + `<div class="api-grid" style="margin-top:8px"><span>Base URL</span><input type="text" data-set="${esc(s.id)}:baseURL" value="${esc(p.baseURL)}" aria-label="${esc(s.label)} base URL" placeholder="${esc(s.defaultBaseURL ?? "")}">`
    + `<span>Model</span><input type="text" data-set="${esc(s.id)}:model" value="${esc(p.model)}" aria-label="${esc(s.label)} model">`
    + (s.needsKey ? `<span>API key</span><span><button class="btn" data-act="key-replace" data-provider="${esc(s.id)}">${p.keySet ? "Replace" : "Set"}</button> <button class="btn" data-act="key-clear" data-provider="${esc(s.id)}"${p.keySet ? "" : " disabled"}>Clear</button></span>` : "")
    + `</div><div class="row-btns"><button class="btn" data-act="select-provider" data-provider="${esc(s.id)}">${active ? "Active ✓" : "Use this provider"}</button>`
    + `<button class="btn" data-act="test-connection" data-provider="${esc(s.id)}">Test connection</button></div>`
    + `<div data-conn="${esc(s.id)}" role="status"></div></div>`;
}

export function routingTableHtml(vm: SettingsVM, ids: string[]): string {
  const rows = ROUTED_OPS.map((op) => {
    const cur = vm.routing[op] ?? "";
    const opts = [`<option value="">default (${esc(vm.activeProvider)})</option>`]
      .concat(ids.map((id) => `<option value="${esc(id)}"${cur === id ? " selected" : ""}>${esc(id)}</option>`)).join("");
    return `<tr><td class="mono">${esc(op)}</td><td><select data-route="${esc(op)}" aria-label="Provider for ${esc(op)}">${opts}</select></td></tr>`;
  }).join("");
  const fb = vm.fallback.map((id, i) =>
    `<div class="frow"><span class="mono">${i + 1}. ${esc(id)}</span><span style="margin-left:auto;display:flex;gap:4px">`
    + `<button class="btn" data-act="fb-up" data-i="${i}" aria-label="Move ${esc(id)} up"${i === 0 ? " disabled" : ""}>↑</button>`
    + `<button class="btn" data-act="fb-down" data-i="${i}" aria-label="Move ${esc(id)} down"${i === vm.fallback.length - 1 ? " disabled" : ""}>↓</button>`
    + `<button class="btn" data-act="fb-rm" data-i="${i}" aria-label="Remove ${esc(id)}">✕</button></span></div>`,
  ).join("");
  return `<div class="deci-label">Per-operation routing</div><div class="table-scroll"><table class="deci-table"><tr><th>Operation</th><th>Provider</th></tr>${rows}</table></div>`
    + `<div class="deci-label" style="margin-top:12px">Fallback order</div>${fb || `<p class="muted">No fallbacks configured.</p>`}`
    + `<div class="row-btns"><select data-fb-add aria-label="Add fallback provider">${ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("")}</select>`
    + `<button class="btn" data-act="fb-add">Add fallback</button></div>`;
}

export function buildSettingsHtml(vm: SettingsVM): string {
  const ids = vm.providers.map((p) => p.spec.id);
  return `<div class="deci-wrap"><p class="deci-label">Deci</p><h1>Settings</h1>`
    + (vm.dirty ? `<div class="banner" role="status">Unsaved changes.</div>` : "")
    + `<h2>Provider</h2>` + vm.providers.map((p) => providerCardHtml(p, p.spec.id === vm.activeProvider)).join("")
    + `<h2>Routing</h2>` + routingTableHtml(vm, ids)
    + `<h2>Privacy</h2><div class="card"><label class="f"><span><input type="checkbox" data-priv="allowCloudAi"${vm.allowCloudAi ? " checked" : ""}> Allow cloud AI</span>`
    + `<span class="muted">When on, prompts and code excerpts may leave this machine for cloud providers. Local-only providers never send data out.</span></label>`
    + `<label class="f"><span><input type="checkbox" data-priv="allowCloudFallback"${vm.allowCloudFallback ? " checked" : ""}> Allow cloud fallback</span>`
    + `<span class="muted">When on, a failing local provider may fall back to a cloud provider.</span></label></div>`
    + `<h2>Analysis defaults</h2><div class="card"><label class="f">Verify after analysis<input type="checkbox" data-def="verify"${vm.verify ? " checked" : ""}></label>`
    + `<label class="f">Static-only (no command execution)<input type="checkbox" data-def="staticOnly"${vm.staticOnly ? " checked" : ""}></label>`
    + `<label class="f">Test timeout (ms)<input type="number" data-def="testTimeoutMs" value="${vm.testTimeoutMs}" min="1000" step="1000"></label></div>`
    + `<div class="row-btns"><button class="btn primary" data-act="save-settings">Save</button><button class="btn" data-act="reset-settings">Reset to defaults</button></div>`
    + `<h2>About</h2><p class="muted">Deci ${esc((vm as { version?: string }).version ?? "")} · analysis stays local; only explicit AI operations contact a provider.</p></div>`;
}

export const SETTINGS_CLIENT_JS = [
  "function handleAct(a,e){var act=a.dataset.act;",
  "if(act==='select-provider'){post({type:'selectProvider',provider:a.dataset.provider});return;}",
  "if(act==='test-connection'){var box=document.querySelector('[data-conn=\"'+a.dataset.provider+'\"]');if(box)box.textContent='Testing…';post({type:'testConnection',provider:a.dataset.provider});return;}",
  "if(act==='key-replace'){post({type:'keyReplace',provider:a.dataset.provider});return;}",
  "if(act==='key-clear'){if(confirm('Clear stored key?'))post({type:'keyClear',provider:a.dataset.provider});return;}",
  "if(act==='fb-up'){post({type:'fallbackMove',from:parseInt(a.dataset.i,10),to:parseInt(a.dataset.i,10)-1});return;}",
  "if(act==='fb-down'){post({type:'fallbackMove',from:parseInt(a.dataset.i,10),to:parseInt(a.dataset.i,10)+1});return;}",
  "if(act==='fb-rm'){post({type:'fallbackRemove',index:parseInt(a.dataset.i,10)});return;}",
  "if(act==='fb-add'){var s=document.querySelector('[data-fb-add]');if(s)post({type:'fallbackAdd',provider:s.value});return;}",
  "if(act==='save-settings'){post({type:'saveSettings',settings:collect()});return;}",
  "if(act==='reset-settings'){if(confirm('Reset all settings to defaults?'))post({type:'resetSettings'});return;}",
  "}",
  "function collect(){var o={routes:{},defs:{},priv:{},providers:{}};document.querySelectorAll('[data-route]').forEach(function(s){o.routes[s.dataset.route]=s.value;});document.querySelectorAll('[data-def]').forEach(function(el){o.defs[el.dataset.def]=el.type==='checkbox'?el.checked:(el.type==='number'?parseInt(el.value,10):el.value);});document.querySelectorAll('[data-priv]').forEach(function(el){o.priv[el.dataset.priv]=el.checked;});document.querySelectorAll('[data-set]').forEach(function(el){var p=el.dataset.set.split(':');if(!o.providers[p[0]])o.providers[p[0]]={};o.providers[p[0]][p[1]]=el.value;});return o;}",
  "document.addEventListener('change',function(){post({type:'settingsDirty'});});",
  "window.addEventListener('message',function(ev){var m=ev.data||{};if(m.type==='connResult'){var box=document.querySelector('[data-conn=\"'+m.provider+'\"]');if(box)box.textContent=m.ok?'Connection OK: '+m.detail:'Failed: '+m.detail;}});",
].join("\n");
