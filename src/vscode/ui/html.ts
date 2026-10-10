// Shared HTML shell + escaping for Deci webviews. Strict CSP with nonce,
// no inline event handlers (delegated data-act clicks only), ALL dynamic
// text through esc(). Pure: view model in, string out.
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON safe to embed inside <script>: escapes < sequences. */
export function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

/** Full HTML document with strict CSP. clientJs must use addEventListener only. */
export function doc(opts: {
  title: string;
  css: string;
  body: string;
  state?: unknown;
  stateVar?: string;
  nonce: string;
  clientJs: string;
}): string {
  const state = opts.state !== undefined
    ? `<script nonce="${opts.nonce}">window.${opts.stateVar ?? "__DECI_STATE__"}=${safeJson(opts.state)};</script>`
    : "";
  return "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">"
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${opts.nonce}';">`
    + `<title>${esc(opts.title)}</title><style>${opts.css}</style></head><body>`
    + opts.body + state
    + `<script nonce="${opts.nonce}">${opts.clientJs}</script></body></html>`;
}

/** Nonce via Math.random (host-provided per panel; uniqueness per load). */
export function makeNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function emptyState(title: string, body: string, action?: { id: string; label: string }): string {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(body)}</p>`
    + (action ? `<button class="btn primary" data-act="${esc(action.id)}">${esc(action.label)}</button>` : "")
    + `</div>`;
}

export function banner(text: string, warn = false): string {
  return `<div class="banner${warn ? " warn" : ""}" role="status">${esc(text)}</div>`;
}

export function severityPill(sev: string): string {
  const letter = { Critical: "C", High: "H", Medium: "M", Low: "L", Verified: "V" }[sev] ?? "?";
  return `<span class="pill pill-${esc(sev)}" title="${esc(sev)}">${esc(letter)} ${esc(sev)}</span>`;
}

/** Minimal client: postMessage helper + delegated data-act clicks + esc. */
export const BASE_CLIENT_JS = [
  "var vscode=acquireVsCodeApi();",
  "function post(t){vscode.postMessage(t);}",
  "function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}",
  "document.addEventListener('click',function(e){var a=e.target.closest?e.target.closest('[data-act]'):null;if(!a)return;handleAct(a,e);});",
].join("\n");
