// Chat webview HTML + interactive response renderer. Single template built
// with concatenation to avoid nested-backtick breakage. Server embeds only
// escaped JSON state; ALL rendering happens client-side from validated
// blocks (see blocks.ts). No AI-generated code is ever executed — the client
// only renders whitelisted block types via predefined components.
import type { ChatMessageItem, ContextFlags, ConversationMeta } from "./chat.js";
import { describeConfig, type LlmConfig } from "./llm.js";

export type { ConversationMeta };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON safe to embed inside <script>: escapes </sequences. */
function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

const CSS = [
  "*{box-sizing:border-box}",
  "body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;height:100vh;display:flex;flex-direction:column}",
  ".chat-container{display:flex;height:100%;flex:1;overflow:hidden}",
  ".sidebar{width:260px;border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;background:var(--vscode-sideBar-background)}",
  ".sidebar-header{padding:12px;border-bottom:1px solid var(--vscode-panel-border);display:flex;justify-content:space-between;align-items:center}",
  ".conversations{flex:1;overflow-y:auto;padding:8px}",
  ".conv-item{padding:8px;border-radius:4px;cursor:pointer;margin-bottom:4px}",
  ".conv-item:hover{background:var(--vscode-list-hoverBackground)}",
  ".conv-item.active{background:var(--vscode-list-activeSelectionBackground)}",
  ".conv-title{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".conv-meta{font-size:11px;color:var(--vscode-descriptionForeground)}",
  ".main{flex:1;display:flex;flex-direction:column;overflow:hidden}",
  ".header{padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
  ".provider-badge{font-size:11px;padding:2px 8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px}",
  ".messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}",
  ".msg{max-width:96%;padding:10px 14px;border-radius:12px}",
  ".msg.user{align-self:flex-end;background:var(--vscode-button-background);color:var(--vscode-button-foreground);max-width:88%}",
  ".msg.assistant{align-self:flex-start;background:var(--vscode-editorWidget-background);max-width:96%}",
  ".msg.tool{align-self:flex-start;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);font-size:12px;max-width:100%}",
  ".msg.system{align-self:center;font-size:11px;color:var(--vscode-descriptionForeground)}",
  ".msg-header{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px}",
  ".msg-content{line-height:1.5;white-space:pre-wrap;word-wrap:break-word}",
  ".msg-content pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:4px;overflow-x:auto}",
  ".block{margin:10px 0;border:1px solid var(--vscode-panel-border);border-radius:8px;overflow:hidden;background:var(--vscode-editor-background)}",
  ".block-title{padding:8px 12px;font-weight:600;font-size:12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-textCodeBlock-background)}",
  ".block-body{padding:10px 12px}",
  ".block-warn{padding:6px 12px;font-size:11px;color:var(--vscode-descriptionForeground);border-top:1px dashed var(--vscode-panel-border)}",
  ".toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}",
  ".chip{font-size:11px;padding:3px 10px;border-radius:12px;border:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-foreground);cursor:pointer}",
  ".chip[aria-pressed=true]{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}",
  ".chip.k-changed{border-left:4px solid #c586c0}.chip.k-direct{border-left:4px solid #4fc1ff}.chip.k-indirect{border-left:4px solid #dcdcaa}.chip.k-test{border-left:4px solid #7ee787}.chip.k-module{border-left:4px solid #ffa657}",
  ".tbtn{font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}",
  ".tbtn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}",
  ".tbtn:focus-visible,.chip:focus-visible,.gnode:focus{outline:2px solid var(--vscode-focusBorder);outline-offset:1px}",
  ".graph-wrap{position:relative}",
  ".graph-svg{width:100%;height:300px;background:var(--vscode-editor-background);border-radius:4px;cursor:grab;touch-action:none}",
  ".graph-svg:active{cursor:grabbing}",
  ".gnode{cursor:pointer}",
  ".gnode rect{stroke:var(--vscode-panel-border);stroke-width:1}",
  ".gnode text{fill:var(--vscode-foreground);font-size:11px}",
  ".gnode.n-changed rect{fill:#c586c033;stroke:#c586c0}.gnode.n-direct rect{fill:#4fc1ff22;stroke:#4fc1ff}.gnode.n-indirect rect{fill:#dcdcaa18;stroke:#dcdcaa}.gnode.n-test rect{fill:#7ee78722;stroke:#7ee787}.gnode.n-module rect{fill:#ffa65722;stroke:#ffa657}",
  ".gnode.dim{opacity:.18}.gnode.hidden{display:none}.gedge.hidden{display:none}",
  ".gedge line{stroke:var(--vscode-descriptionForeground);stroke-width:1.2}",
  ".gedge text{fill:var(--vscode-descriptionForeground);font-size:9px}",
  ".gnode.sel rect{stroke:var(--vscode-focusBorder);stroke-width:2.5}",
  ".gedge.hot line{stroke:var(--vscode-focusBorder);stroke-width:2.2}",
  ".gsearch{font-size:12px;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;min-width:140px}",
  ".detail{margin-top:8px;padding:8px 10px;border:1px solid var(--vscode-panel-border);border-radius:6px;font-size:12px;background:var(--vscode-textCodeBlock-background)}",
  ".detail h4{margin:0 0 4px;font-size:12px}",
  ".detail .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}",
  ".bar-row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px}",
  ".bar-label{width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-descriptionForeground)}",
  ".bar-track{flex:1;height:14px;background:var(--vscode-textCodeBlock-background);border-radius:3px;overflow:hidden}",
  ".bar-fill{height:100%;background:var(--vscode-button-background)}",
  ".bar-val{width:56px;text-align:right;font-variant-numeric:tabular-nums}",
  ".diff-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
  ".diff-pane{font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre;overflow:auto;max-height:260px;padding:8px;border-radius:4px;background:var(--vscode-textCodeBlock-background)}",
  ".diff-pane .add{background:#7ee78726}.diff-pane .del{background:#f8514926}",
  ".frow{display:flex;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px;cursor:pointer}",
  ".frow:hover{background:var(--vscode-list-hoverBackground)}",
  ".sev{font-size:10px;font-weight:700;padding:1px 8px;border-radius:8px;white-space:nowrap}",
  ".sev-Critical{background:#f8514944}.sev-High{background:#ffa65744}.sev-Medium{background:#dcdcaa33}.sev-Low{background:#4fc1ff33}",
  ".st{font-size:10px;font-weight:700;padding:1px 8px;border-radius:8px;white-space:nowrap}",
  ".st-passed{background:#7ee78733}.st-failed{background:#f8514944}.st-skipped,.st-blocked,.st-unexecuted{background:#8b949e33}",
  ".api-grid{display:grid;grid-template-columns:110px 1fr;gap:6px;font-size:12px;align-items:center}",
  ".api-grid input,.api-grid select,.api-grid textarea{font-size:12px;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;font-family:inherit}",
  ".method{font-weight:700;font-size:11px;padding:2px 8px;border-radius:4px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}",
  ".action-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
  ".input-area{padding:12px;border-top:1px solid var(--vscode-panel-border)}",
  ".context-toggles{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}",
  ".flag-btn{font-size:11px;padding:4px 8px;border:none;border-radius:3px;cursor:pointer;opacity:.6}",
  ".flag-btn.active{opacity:1;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}",
  ".input-row{display:flex;gap:8px;align-items:flex-end}",
  ".input-row textarea{flex:1;min-height:40px;max-height:200px;padding:8px 12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;font-family:inherit;resize:vertical}",
  ".send-btn,.stop-btn,.new-conv-btn{padding:8px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:6px;cursor:pointer}",
  ".send-btn:disabled{opacity:.5;cursor:not-allowed}",
  ".empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--vscode-descriptionForeground);text-align:center;padding:24px}",
  "@media (max-width:700px){.sidebar{display:none}.diff-grid{grid-template-columns:1fr}}",
].join("\n");

const CLIENT_JS = [
  "var vscode=acquireVsCodeApi();",
  "var activeConvId=window.__DECI_ACTIVE__||null;var isStreaming=false;var GST={};",
  "function post(t){vscode.postMessage(t);}",
  "function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}",
  "function stripFences(s){return String(s).replace(/```deci-block[\\s\\S]*?```/g,'').trim();}",
  "function md(src){var h=esc(stripFences(src));h=h.replace(/```(\\w+)?\\n([\\s\\S]*?)```/g,function(m,l,c){return '<pre><code>'+c+'</code></pre>';});h=h.replace(/`([^`\\n]+)`/g,'<code>$1</code>');h=h.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');return h.replace(/\\n/g,'<br>');}",
  "function enc(o){return encodeURIComponent(JSON.stringify(o));}",
  "function dec(s){try{return JSON.parse(decodeURIComponent(s));}catch(e){return {};}}",
  // shell: conversations, send, flags
  "var list=document.getElementById('convList');",
  "if(list){list.addEventListener('click',function(e){var it=e.target.closest('.conv-item');if(it){activeConvId=it.dataset.id;post({type:'selectConversation',conversationId:activeConvId});}});}",
  "var nb=document.getElementById('newConvBtn');if(nb){nb.addEventListener('click',function(){var t=prompt('Conversation title:')||'New conversation';post({type:'newConversation',title:t});});}",
  "function sendMessage(){var el=document.getElementById('msgInput');var t=(el.value||'').trim();if(!t||isStreaming)return;el.value='';setStreaming(true);post({type:'sendMessage',conversationId:activeConvId,text:t});}",
  "var sb=document.getElementById('sendBtn');if(sb){sb.addEventListener('click',sendMessage);}",
  "var mi=document.getElementById('msgInput');if(mi){mi.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});}",
  "var stp=document.getElementById('stopBtn');if(stp){stp.addEventListener('click',function(){setStreaming(false);post({type:'cancel',conversationId:activeConvId});});}",
  "document.querySelectorAll('.flag-btn').forEach(function(b){b.addEventListener('click',function(){b.classList.toggle('active');post({type:'toggleContextFlag',flag:b.dataset.flag,active:b.classList.contains('active')});});});",
  "function setStreaming(v){isStreaming=v;var s=document.getElementById('sendBtn');if(s)s.disabled=v;var t=document.getElementById('stopBtn');if(t)t.style.display=v?'inline-block':'none';}",
  // message render
  "window.addEventListener('message',function(ev){var m=ev.data||{};if(m.type==='updateConversations')renderConvs(m.conversations,m.activeId);else if(m.type==='updateMessages'){renderMsgs(m.messages);updateFlags(m.contextFlags);updateProvider(m.providerStatus);setStreaming(false);}else if(m.type==='messageChunk')appendChunk(m.chunk,m.messageId);else if(m.type==='toolApproval')showApproval(m.invocation);else if(m.type==='toolResult')showResult(m.result);else if(m.type==='error')showError(m.error);else if(m.type==='streamingState')setStreaming(!!m.streaming);else if(m.type==='blockUpdate')updateBlocks(m.messageId,m.blocks,m.warnings);});",
  "function renderConvs(cs,a){var el=document.getElementById('convList');if(!el)return;el.innerHTML=(cs||[]).map(function(c){return '<div class=\"conv-item '+(c.id===a?'active':'')+'\" data-id=\"'+c.id+'\"><div class=\"conv-title\">'+esc(c.title)+'</div><div class=\"conv-meta\">'+c.messageCount+' msgs</div></div>';}).join('');}",
  "function renderMsgs(ms){var c=document.getElementById('messages');if(!c)return;if(!ms||!ms.length){c.innerHTML='<div class=\"empty-state\"><h3>No messages yet</h3><p>Ask Deci about your project.</p></div>';return;}c.innerHTML=ms.map(renderMsg).join('');c.scrollTop=c.scrollHeight;}",
  "function renderMsg(m){var hb=m.handledBy?'<span> '+esc(m.handledBy.provider)+':'+esc(m.handledBy.model)+'</span>':'';var retry=m.role==='assistant'?\" <button class=\\\"retry-btn tbtn\\\" data-conv-id=\\\"\"+activeConvId+\"\\\">Retry</button>\":'';var ctl='<button class=\"copy-btn tbtn\" data-id=\"'+m.id+'\">Copy</button>'+retry;var body='';if(m.role==='tool'){body='<details><summary>Tool: '+esc((m.toolResult||{}).name||'tool')+'</summary>'+esc(m.content)+'</details>';}else if(m.role==='assistant'&&m.blocks&&m.blocks.length){body=m.blocks.map(function(b,i){return renderBlock(b,m.id,i);}).join('');if(m.blockWarnings&&m.blockWarnings.length){body+='<div class=\"block-warn\">'+m.blockWarnings.map(esc).join('<br>')+'</div>';}}else{body=md(m.content);}return '<div class=\"msg '+m.role+'\" data-id=\"'+m.id+'\"><div class=\"msg-header\">'+esc(m.role)+hb+' '+ctl+'</div><div class=\"msg-content\">'+body+'</div></div>';}",
  "function updateBlocks(mid,blocks,warnings){var host=document.querySelector('[data-id=\"'+mid+'\"] .msg-content');if(!host)return;host.innerHTML=(blocks||[]).map(function(b,i){return renderBlock(b,mid,i);}).join('')+((warnings&&warnings.length)?'<div class=\"block-warn\">'+warnings.map(esc).join('<br>')+'</div>':'');}",
  // block dispatcher
  "function renderBlock(b,mid,idx){var key=mid+':'+idx;if(!b||typeof b.type!=='string')return '<div class=\"block\"><div class=\"block-body\">Unsupported content.</div></div>';if(b.type==='text')return '<div>'+md(b.markdown||'')+'</div>';if(b.type==='graph')return renderGraph(b,key);if(b.type==='chart')return renderChart(b,key);if(b.type==='code_diff')return renderDiff(b,key);if(b.type==='test_results')return renderTests(b,key);if(b.type==='findings')return renderFindings(b,key);if(b.type==='api_request')return renderApi(b,key);if(b.type==='action')return renderAction(b,key);return '<div class=\"block\"><div class=\"block-body\">Unsupported block: '+esc(b.type)+'</div></div>';}",
  // graph
  "var GKIND=['changed','direct','indirect','test','module'];var GCOL={changed:'#c586c0',direct:'#4fc1ff',indirect:'#dcdcaa',test:'#7ee787',module:'#ffa657'};",
  "function gstate(key,nodes,edges){if(!GST[key])GST[key]={k:1,x:0,y:0,sel:null,off:{},q:''};var st=GST[key];st.nodes=nodes;st.edges=edges;return st;}",
  "function glayout(nodes){var cols={};GKIND.forEach(function(k,i){cols[k]=[];});nodes.forEach(function(n){(cols[n.kind]||cols.direct).push(n);});var pos={};var W=760,H=300;GKIND.forEach(function(k,ci){var arr=cols[k];arr.forEach(function(n,ri){var x=20+ci*180;var y=arr.length>1?20+ri*((H-70)/Math.max(1,arr.length-1)):120;pos[n.id]={x:x,y:y};});});return {pos:pos,W:W,H:H};}",
  "function renderGraph(b,key){var nodes=(b.nodes||[]).slice(0,120);var edges=(b.edges||[]).slice(0,200);gstate(key,nodes,edges);var L=glayout(nodes);var parts=[];parts.push('<div class=\"block\" data-gkey=\"'+key+'\"><div class=\"block-title\">'+esc(b.title||'Graph')+' ('+nodes.length+' nodes, '+edges.length+' edges)</div><div class=\"block-body\">');parts.push('<div class=\"toolbar\" role=\"toolbar\" aria-label=\"Graph controls\"><input class=\"gsearch\" data-g=\"'+key+'\" placeholder=\"Search nodes\" aria-label=\"Search nodes\">');GKIND.forEach(function(k){parts.push('<button class=\"chip k-'+k+'\" data-gact=\"filter\" data-g=\"'+key+'\" data-kind=\"'+k+'\" aria-pressed=\"false\">'+k+'</button>');});parts.push('<button class=\"tbtn\" data-gact=\"fit\" data-g=\"'+key+'\">Fit</button><button class=\"tbtn\" data-gact=\"reset\" data-g=\"'+key+'\">Reset</button></div>');parts.push('<div class=\"graph-wrap\"><svg class=\"graph-svg\" data-g=\"'+key+'\" tabindex=\"0\" role=\"tree\" aria-label=\"'+esc(b.title||'Graph')+'\">');edges.forEach(function(e,i){var a=L.pos[e.from],c=L.pos[e.to];if(!a||!c)return;var mx=(a.x+c.x)/2;parts.push('<g class=\"gedge\" data-from=\"'+esc(e.from)+'\" data-to=\"'+esc(e.to)+'\"><line x1=\"'+(a.x+120)+'\" y1=\"'+(a.y+17)+'\" x2=\"'+c.x+'\" y2=\"'+(c.y+17)+'\"/><text x=\"'+mx+'\" y=\"'+((a.y+c.y)/2)+'\">'+esc(e.label||'')+'</text><title>'+esc(e.label+' ('+e.evidence+')')+'</title></g>');});nodes.forEach(function(n){var p=L.pos[n.id];parts.push('<g class=\"gnode n-'+n.kind+'\" data-node=\"'+esc(n.id)+'\" data-g=\"'+key+'\" tabindex=\"-1\" role=\"treeitem\" aria-label=\"'+esc(n.label+' '+n.kind)+'\"><rect x=\"'+p.x+'\" y=\"'+p.y+'\" width=\"120\" height=\"34\" rx=\"6\"/><text x=\"'+(p.x+8)+'\" y=\"'+(p.y+21)+'\">'+esc(String(n.label).slice(0,16))+'</text><title>'+esc(n.label+(n.file?'\\n'+n.file:'')+(n.detail?'\\n'+n.detail:''))+'</title></g>');});parts.push('</svg></div>');parts.push('<div class=\"detail\" data-detail=\"'+key+'\">Select a node to inspect its source, dependencies, and tests.</div>');if(b.unresolved&&b.unresolved.length){parts.push('<div class=\"block-warn\">Coverage gaps: '+b.unresolved.map(esc).join('; ')+'</div>');}parts.push('</div></div>');return parts.join('');}",
  "function gapply(key){var st=GST[key];if(!st)return;var root=document.querySelector('[data-gkey=\"'+key+'\"]');if(!root)return;var svg=root.querySelector('svg');var g=svg.querySelector('g.gviewport');if(!g){var inner=svg.innerHTML;svg.innerHTML='<g class=\"gviewport\">'+inner+'</g>';g=svg.querySelector('g.gviewport');}g.setAttribute('transform','translate('+st.x+','+st.y+') scale('+st.k+')');root.querySelectorAll('.gnode').forEach(function(el){var n=st.nodes.filter(function(x){return x.id===el.dataset.node;})[0];var hide=!!st.off[n?n.kind:''];var dim=st.q&&n&&n.label.toLowerCase().indexOf(st.q)<0;el.classList.toggle('hidden',hide);el.classList.toggle('dim',!!dim&&!hide);el.classList.toggle('sel',st.sel===el.dataset.node);});root.querySelectorAll('.gedge').forEach(function(el){var rel=st.sel&&(el.dataset.from===st.sel||el.dataset.to===st.sel);el.classList.toggle('hot',!!rel);if(st.sel){el.classList.toggle('dim',!rel);}else{el.classList.remove('dim');}});}",
  "function gselect(key,id){var st=GST[key];if(!st)return;st.sel=(st.sel===id?null:id);gapply(key);var d=document.querySelector('[data-detail=\"'+key+'\"]');if(!d)return;var n=st.nodes.filter(function(x){return x.id===id;})[0];if(!st.sel||!n){d.innerHTML='Select a node to inspect its source, dependencies, and tests.';return;}var nb=st.edges.filter(function(e){return e.from===id||e.to===id;}).length;d.innerHTML='<h4>'+esc(n.label)+' <span class=\"sev sev-Medium\">'+esc(n.kind)+'</span></h4><div>'+esc(n.detail||'')+'</div>'+(n.file?'<div>'+esc(n.file)+(n.line?':'+n.line:'')+' · '+nb+' observed relation(s)</div>':'')+'<div class=\"row\">'+(n.file?'<button class=\"tbtn primary\" data-act=\"open-file\" data-path=\"'+esc(n.file)+'\" data-line=\"'+(n.line||'')+'\">Open source</button>':'')+'<button class=\"tbtn\" data-act=\"ask-about\" data-kind=\"'+esc(n.kind)+'\" data-label=\"'+esc(n.label)+'\" data-path=\"'+esc(n.file||'')+'\" data-line=\"'+(n.line||'')+'\">Explain</button></div>';}",
  // chart
  "function renderChart(b,key){var parts=['<div class=\"block\"><div class=\"block-title\">'+esc(b.title||'Chart')+'</div><div class=\"block-body\" data-ckey=\"'+key+'\">'];var max=1;(b.series||[]).forEach(function(s){(s.points||[]).forEach(function(p){if(p.value>max)max=p.value;});});(b.series||[]).forEach(function(si,s){parts.push('<div data-series=\"'+s+'\"><div class=\"toolbar\"><button class=\"chip\" data-cact=\"toggle\" data-ckey=\"'+key+'\" data-s=\"'+s+'\" aria-pressed=\"true\">'+esc(si.name)+'</button></div>');(si.points||[]).slice(0,60).forEach(function(p){var w=max>0?Math.round(p.value/max*100):0;parts.push('<div class=\"bar-row\"><span class=\"bar-label\">'+esc(p.label)+'</span><span class=\"bar-track\"><span class=\"bar-fill\" style=\"display:block;width:'+w+'%\"></span></span><span class=\"bar-val\">'+p.value+'</span></div>');});parts.push('</div>');});parts.push('</div></div>');return parts.join('');}",
  // diff
  "function linediff(o,p){var a=o.split('\\n'),c=p.split('\\n');var inA={};a.forEach(function(l){inA[l]=(inA[l]||0)+1;});var inP={};c.forEach(function(l){inP[l]=(inP[l]||0)+1;});return {left:a.map(function(l){return {t:l,cls:inP[l]?'':'del'};}),right:c.map(function(l){return {t:l,cls:inA[l]?'':'add'};})};}",
  "function renderDiff(b,key){var d=linediff(b.original||'',b.proposed||'');function pane(rows){return rows.map(function(r){return '<div class=\"'+r.cls+'\">'+esc(r.t)+'</div>';}).join('');}var act=b.action?'<button class=\"tbtn\" data-act=\"do-action\" data-action=\"'+esc(b.action.name)+'\" data-p=\"'+enc(b.action.args)+'\">Review action: '+esc(b.action.name)+'</button>':'';return '<div class=\"block\"><div class=\"block-title\">'+esc(b.title||('Diff: '+b.file))+'</div><div class=\"block-body\"><div>'+esc(b.description||'')+'</div><div class=\"diff-grid\"><div class=\"diff-pane\">'+pane(d.left)+'</div><div class=\"diff-pane\">'+pane(d.right)+'</div></div><div class=\"toolbar\" style=\"margin-top:8px\"><button class=\"tbtn\" data-act=\"copy-text\" data-t=\"'+enc(b.proposed||'')+'\">Copy proposed</button>'+act+'<button class=\"tbtn\" data-act=\"open-file\" data-path=\"'+esc(b.file)+'\">Open file</button></div></div></div>';}",
  // tests
  "function renderTests(b,key){var parts=['<div class=\"block\" data-tkey=\"'+key+'\"><div class=\"block-title\">'+esc(b.title||'Tests')+'</div><div class=\"block-body\">'];var sts=['all','passed','failed'];parts.push('<div class=\"toolbar\" role=\"toolbar\" aria-label=\"Test filters\">'+sts.map(function(s){return '<button class=\"chip\" data-tact=\"filter\" data-tkey=\"'+key+'\" data-s=\"'+s+'\" aria-pressed=\"'+(s==='all')+'\">'+s+'</button>';}).join('')+'<button class=\"tbtn primary\" data-act=\"do-action\" data-action=\"run_tests\" data-p=\"'+enc({paths:(b.results||[]).map(function(r){return r.path;}).join(',')})+'\">Run these tests</button></div>');(b.results||[]).forEach(function(r){parts.push('<div class=\"frow\" data-status=\"'+esc(r.status)+'\" data-trow=\"'+key+'\"><span class=\"st st-'+esc(r.status)+'\">'+esc(r.status)+'</span><span>'+esc(r.path)+'</span><span style=\"color:var(--vscode-descriptionForeground)\">'+esc(r.detail||'')+'</span><span style=\"margin-left:auto;display:flex;gap:4px\"><button class=\"tbtn\" data-act=\"open-file\" data-path=\"'+esc(r.path)+'\">Open</button>'+(r.status==='failed'?'<button class=\"tbtn\" data-act=\"ask-about\" data-kind=\"test-failure\" data-label=\"'+esc(r.path)+'\" data-path=\"'+esc(r.path)+'\">Diagnose</button><button class=\"tbtn\" data-act=\"do-action\" data-action=\"propose_fix\" data-p=\"'+enc({testPath:r.path})+'\">Propose fix</button>':'')+'</span></div>');if(r.output){parts.push('<details data-trow=\"'+key+'\" data-status=\"'+esc(r.status)+'\"><summary>log: '+esc(r.path)+'</summary><pre>'+esc(r.output)+'</pre></details>');}});if(b.diagnosis){var dg=b.diagnosis;parts.push('<div class=\"detail\"><h4>Diagnosis: '+esc(dg.testPath)+'</h4><div>'+esc(dg.summary)+'</div>');dg.causes.forEach(function(c){parts.push('<div>- '+esc(c)+'</div>');});dg.frames.forEach(function(f){parts.push('<div><button class=\"tbtn\" data-act=\"open-file\" data-path=\"'+esc(f.path)+'\" data-line=\"'+(f.line||'')+'\">'+esc(f.path+(f.line?':'+f.line:''))+'</button></div>');});parts.push('</div>');}parts.push('</div></div>');return parts.join('');}",
  // findings
  "function renderFindings(b,key){var parts=['<div class=\"block\" data-fkey=\"'+key+'\"><div class=\"block-title\">'+esc(b.title||'Findings')+'</div><div class=\"block-body\">'];var sevs=['all','Critical','High','Medium','Low'];parts.push('<div class=\"toolbar\" role=\"toolbar\" aria-label=\"Severity filters\">'+sevs.map(function(s){return '<button class=\"chip\" data-fact=\"filter\" data-fkey=\"'+key+'\" data-s=\"'+s+'\" aria-pressed=\"'+(s==='all')+'\">'+s+'</button>';}).join('')+'</div>');(b.rows||[]).forEach(function(r){parts.push('<div class=\"frow\" data-sev=\"'+esc(r.severity)+'\" data-frow=\"'+key+'\"><span class=\"sev sev-'+esc(r.severity)+'\">'+esc(r.severity)+'</span><span>'+esc(r.finding)+'</span><span style=\"color:var(--vscode-descriptionForeground)\">'+esc(r.file+(r.line?':'+r.line:''))+' · '+esc(r.standing)+'</span><span style=\"margin-left:auto;display:flex;gap:4px\"><button class=\"tbtn\" data-act=\"open-file\" data-path=\"'+esc(r.file)+'\" data-line=\"'+(r.line||'')+'\">Code</button><button class=\"tbtn\" data-act=\"ask-about\" data-kind=\"finding\" data-label=\"'+esc(r.finding.slice(0,80))+'\" data-path=\"'+esc(r.file)+'\" data-line=\"'+(r.line||'')+'\">Explain</button></span></div>');});parts.push('</div></div>');return parts.join('');}",
  // api
  "function renderApi(b,key){return '<div class=\"block\"><div class=\"block-title\">'+esc(b.title||('API: '+b.name))+'</div><div class=\"block-body\"><div class=\"api-grid\"><span class=\"method\">'+esc(b.method)+'</span><input data-api=\"path:'+key+'\" value=\"'+esc(b.path)+'\" aria-label=\"Request path\"><span>Signature</span><span>'+esc(b.signature)+'</span><span>Source</span><span><button class=\"tbtn\" data-act=\"open-file\" data-path=\"'+esc(b.file)+'\" data-line=\"'+(b.line||'')+'\">'+esc(b.file+(b.line?':'+b.line:''))+'</button></span></div><div class=\"toolbar\" style=\"margin-top:8px\"><button class=\"tbtn\" data-act=\"copy-text\" data-t=\"'+enc(b.method+' '+b.path)+'\">Copy request</button><button class=\"tbtn\" data-act=\"ask-about\" data-kind=\"endpoint\" data-label=\"'+esc(b.name)+'\" data-path=\"'+esc(b.file)+'\" data-line=\"'+(b.line||'')+'\">Ask Deci</button></div><div class=\"block-warn\">Live execution is disabled in the explorer: requests are never sent from this view. Run the project suite or ask Deci for verified behavior.</div></div></div>';}",
  // action
  "function renderAction(b,key){return '<div class=\"block\"><div class=\"block-title\">'+esc(b.title||'Action')+'</div><div class=\"block-body\"><div class=\"action-row\"><span>'+esc(b.label)+'</span>'+(b.requiresApproval?'<span class=\"st st-blocked\">needs approval</span>':'')+'<button class=\"tbtn primary\" data-act=\"do-action\" data-action=\"'+esc(b.action)+'\" data-p=\"'+enc(b.params||{})+'\" data-need=\"'+(b.requiresApproval?'1':'')+'\">'+esc(b.label)+'</button></div><div class=\"action-confirm\" data-confirm=\"'+key+'\"></div></div></div>';}",
  // delegated events
  "document.addEventListener('click',function(e){var t=e.target;if(t.matches('.retry-btn')){post({type:'retry',conversationId:t.dataset.convId});return;}if(t.matches('.copy-btn')){var id=t.dataset.id;var el=document.querySelector('[data-id=\"'+id+'\"] .msg-content');if(el)navigator.clipboard.writeText(el.innerText);return;}if(t.matches('.approve-btn')){post({type:'approveTool',toolCallId:t.dataset.callId,approved:true});return;}if(t.matches('.reject-btn')){post({type:'approveTool',toolCallId:t.dataset.callId,approved:false});return;}",
  "var g=t.closest('[data-gkey]');var gkey=g?g.dataset.gkey:null;",
  "if(t.matches('[data-gact=\"filter\"]')){var st=GST[t.dataset.g];if(st){var k=t.dataset.kind;st.off[k]=!st.off[k];t.setAttribute('aria-pressed',st.off[k]?'true':'false');gapply(t.dataset.g);}return;}",
  "if(t.matches('[data-gact=\"fit\"]')){var s2=GST[t.dataset.g];if(s2){s2.k=1;s2.x=0;s2.y=0;gapply(t.dataset.g);}return;}",
  "if(t.matches('[data-gact=\"reset\"]')){var s3=GST[t.dataset.g];if(s3){s3.k=1;s3.x=0;s3.y=0;s3.sel=null;s3.off={};s3.q='';var si=g?g.querySelector('.gsearch'):null;if(si)si.value='';gapply(t.dataset.g);var dd=document.querySelector('[data-detail=\"'+t.dataset.g+'\"]');if(dd)dd.innerHTML='Select a node to inspect its source, dependencies, and tests.';}return;}",
  "if(t.matches('.gnode')){gselect(t.dataset.g,t.dataset.node);return;}",
  "if(t.matches('[data-cact=\"toggle\"]')){var on=t.getAttribute('aria-pressed')==='true';t.setAttribute('aria-pressed',on?'false':'true');var sib=t.closest('[data-ckey]').querySelector('[data-series=\"'+t.dataset.s+'\"]');if(sib)sib.style.display=on?'none':'';return;}",
  "if(t.matches('[data-tact=\"filter\"]')){var tk=t.dataset.tkey;var sv=t.dataset.s;var root2=t.closest('[data-tkey]');root2.querySelectorAll('[data-tact]').forEach(function(c){c.setAttribute('aria-pressed',c===t?'true':'false');});root2.querySelectorAll('[data-trow]').forEach(function(r){r.style.display=(sv==='all'||r.dataset.status===sv)?'':'none';});return;}",
  "if(t.matches('[data-fact=\"filter\"]')){var fk=t.dataset.fkey;var fv=t.dataset.s;var root3=t.closest('[data-fkey]');root3.querySelectorAll('[data-fact]').forEach(function(c){c.setAttribute('aria-pressed',c===t?'true':'false');});root3.querySelectorAll('[data-frow]').forEach(function(r){r.style.display=(fv==='all'||r.dataset.sev===fv)?'':'none';});return;}",
  "var a=t.closest('[data-act]');if(!a)return;var act=a.dataset.act;",
  "if(act==='open-file'){post({type:'openFile',path:a.dataset.path||'',line:a.dataset.line||''});return;}",
  "if(act==='ask-about'){post({type:'askAbout',selection:{kind:a.dataset.kind||'item',label:a.dataset.label||'',file:a.dataset.path||undefined,line:a.dataset.line?parseInt(a.dataset.line,10):null}});return;}",
  "if(act==='copy-text'){navigator.clipboard.writeText(decodeURIComponent(a.dataset.t||''));return;}",
  "if(act==='do-action'){if(a.dataset.need==='1'){var ck=a.closest('.block').querySelector('[data-confirm]');if(ck&&!ck.dataset.armed){ck.dataset.armed='1';ck.innerHTML='<span>This modifies the workspace. </span><button class=\"tbtn primary\" data-act=\"do-action-go\" data-action=\"'+a.dataset.action+'\" data-p=\"'+a.dataset.p+'\">Approve</button> <button class=\"tbtn\" data-act=\"do-action-no\">Cancel</button>';return;}}post({type:'doAction',action:a.dataset.action,params:dec(a.dataset.p||'%7B%7D'),approved:a.dataset.need==='1'});return;}",
  "if(act==='do-action-go'){post({type:'doAction',action:a.dataset.action,params:dec(a.dataset.p||'%7B%7D'),approved:true});return;}",
  "if(act==='do-action-no'){var cc=a.closest('.block').querySelector('[data-confirm]');if(cc){cc.dataset.armed='';cc.innerHTML='';}return;}",
  "});",
  // graph pan/zoom + search + keyboard
  "document.addEventListener('wheel',function(e){var svg=e.target.closest?e.target.closest('svg.graph-svg'):null;if(!svg)return;e.preventDefault();var st=GST[svg.dataset.g];if(!st)return;var f=e.deltaY>0?0.9:1.1;st.k=Math.min(2.5,Math.max(0.4,st.k*f));gapply(svg.dataset.g);},{passive:false});",
  "document.addEventListener('pointerdown',function(e){var svg=e.target.closest?e.target.closest('svg.graph-svg'):null;if(!svg||(e.target.closest('.gnode')))return;var st=GST[svg.dataset.g];if(!st)return;var sx=e.clientX,sy=e.clientY,ox=st.x,oy=st.y;function mv(ev){st.x=ox+(ev.clientX-sx)/st.k;st.y=oy+(ev.clientY-sy)/st.k;gapply(svg.dataset.g);}function up(){document.removeEventListener('pointermove',mv);document.removeEventListener('pointerup',up);}document.addEventListener('pointermove',mv);document.addEventListener('pointerup',up);});",
  "document.addEventListener('input',function(e){var t=e.target;if(t.matches&&t.matches('.gsearch')){var st=GST[t.dataset.g];if(st){st.q=t.value.toLowerCase();gapply(t.dataset.g);}}});",
  "document.addEventListener('keydown',function(e){var svg=e.target.closest?e.target.closest('svg.graph-svg'):null;if(svg){var st=GST[svg.dataset.g];if(!st||!st.nodes.length)return;var ids=st.nodes.map(function(n){return n.id;});var i=ids.indexOf(st.sel);if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();gselect(svg.dataset.g,ids[(i+1+ids.length)%ids.length]);}else if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();gselect(svg.dataset.g,ids[(i-1+ids.length)%ids.length]);}else if(e.key==='Escape'){st.sel=null;gapply(svg.dataset.g);}return;}if(e.key==='/'&&document.activeElement!==mi){var m2=document.getElementById('msgInput');if(m2){e.preventDefault();m2.focus();}}});",
  "function appendChunk(ch,id){var el=document.querySelector('[data-id=\"'+id+'\"] .msg-content');if(!el){var c=document.getElementById('messages');if(!c)return;var d=document.createElement('div');d.className='msg assistant';d.dataset.id=id;d.innerHTML='<div class=\"msg-header\">assistant</div><div class=\"msg-content\"></div>';c.appendChild(d);el=d.querySelector('.msg-content');}el.textContent+=ch;}",
  "function showApproval(inv){var c=document.getElementById('messages');if(!c)return;var d=document.createElement('div');d.className='msg tool';d.innerHTML='<div class=\"msg-header\">Approval: '+esc(inv.name)+'</div><pre>'+esc(JSON.stringify(inv.args,null,2))+'</pre><button class=\"approve-btn tbtn\" data-call-id=\"'+inv.callId+'\">Approve</button> <button class=\"reject-btn tbtn\" data-call-id=\"'+inv.callId+'\">Reject</button>';c.appendChild(d);c.scrollTop=c.scrollHeight;}",
  "function showResult(r){var c=document.getElementById('messages');if(!c)return;var d=document.createElement('div');d.className='msg tool';d.innerHTML='<div class=\"msg-header\">Tool: '+esc(r.name)+'</div><pre>'+esc(r.error?('Error: '+r.error):r.output)+'</pre>';c.appendChild(d);c.scrollTop=c.scrollHeight;}",
  "function showError(e){var c=document.getElementById('messages');if(!c)return;var d=document.createElement('div');d.className='msg system';d.textContent='Error: '+e;c.appendChild(d);c.scrollTop=c.scrollHeight;}",
  "function updateFlags(f){if(!f)return;document.querySelectorAll('.flag-btn').forEach(function(b){b.classList.toggle('active',!!f[b.dataset.flag]);});}",
  "function updateProvider(s){var b=document.getElementById('providerBadge');if(b&&s)b.textContent=s;}",
  "if(window.__DECI_STATE__){renderMsgs(window.__DECI_STATE__);}",
].join("\n");

/** Client bundle source, exported for headless renderer tests. */
export function chatClientJs(): string {
  return CLIENT_JS;
}

function flagButtons(flags: ContextFlags): string {  const defs: Array<[keyof ContextFlags, string]> = [
    ["activeFile", "File"], ["diff", "Diff"], ["impact", "Impact"],
    ["tests", "Tests"], ["apiContracts", "API"], ["docs", "Docs"],
  ];
  return defs.map(([k, label]) => `<button class="flag-btn${flags[k] ? " active" : ""}" data-flag="${k}">${label}</button>`).join("");
}

/** Build full chat HTML for the webview. Pure (string building only). */
export function buildChatHtml(
  conversations: ConversationMeta[],
  activeId: string | null,
  messages: ChatMessageItem[],
  contextFlags: ContextFlags,
  providerConfig: LlmConfig,
): string {
  const providerStatus = escapeHtml(describeConfig(providerConfig));
  const convList = conversations.length === 0
    ? `<div class="empty-state"><p>No conversations yet.</p></div>`
    : conversations.map((c) =>
      `<div class="conv-item${c.id === activeId ? " active" : ""}" data-id="${c.id}"><div class="conv-title">${escapeHtml(c.title)}</div><div class="conv-meta">${c.messageCount} msgs</div></div>`,
    ).join("");
  const main = activeId === null
    ? `<div class="empty-state"><h3>Welcome to Deci Chat</h3><p>Start a new conversation to chat about your codebase. Context, tools, and provider status appear here.</p></div>`
    : `<header class="header"><span id="providerBadge" class="provider-badge">${providerStatus}</span></header>`
      + `<div class="messages" id="messages"></div>`
      + `<div class="input-area"><div class="context-toggles">${flagButtons(contextFlags)}</div>`
      + `<div class="input-row"><textarea id="msgInput" placeholder="Ask Deci about your codebase…" rows="1" aria-label="Chat message"></textarea>`
      + `<button class="send-btn" id="sendBtn">Send</button><button class="stop-btn" id="stopBtn" style="display:none">Stop</button></div></div>`;
  return "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">"
    + "<style>" + CSS + "</style></head><body>"
    + "<div class=\"chat-container\"><aside class=\"sidebar\">"
    + "<header class=\"sidebar-header\"><span>Conversations</span><button class=\"new-conv-btn\" id=\"newConvBtn\">New</button></header>"
    + "<nav class=\"conversations\" id=\"convList\">" + convList + "</nav></aside>"
    + "<main class=\"main\" id=\"mainArea\">" + main + "</main></div>"
    + "<script>window.__DECI_ACTIVE__=" + JSON.stringify(activeId) + ";window.__DECI_STATE__=" + safeJson(messages) + ";</script>"
    + "<script>" + CLIENT_JS + "</script></body></html>";
}
