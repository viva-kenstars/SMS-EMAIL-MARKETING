/* Sendzad workspace: independent saved-template studio and email configuration views.
 * Source module; no framework, third-party editor runtime, or automatic sends.
 */
(() => {
'use strict';
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={ctx:null,record:null,seed:null,mode:'design',device:'desktop',selected:null,history:[],position:0,busy:false,change:0};
const preview=document.body.dataset.preview==='true';
const button=(label,action,primary=false,attrs='')=>`<button type="button" class="btn ${primary?'primary':''}" data-sz="${action}" ${attrs}>${label}</button>`;
const blank=()=>({name:'',category:'',subject:'',preheader:'',text_body:'',html:'<table role="presentation" width="640" class="tz-container" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:640px;font-family:Arial,sans-serif;background-color:#ffffff"><tr><td style="padding:32px"><table role="presentation" width="100%" data-tz-block="header"><tr><td><h2>{{brand_name}}</h2></td></tr></table><table role="presentation" width="100%" data-tz-block="text"><tr><td><h1>Your headline</h1><p>Hi {{first_name}},</p><p>Write your message here.</p></td></tr></table><table role="presentation" width="100%" data-tz-block="footer"><tr><td style="padding-top:24px;border-top:1px solid #d1d5db"><p>{{brand_name}}<br>{{postal_address}}</p><p>{{permission_reminder}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a></td></tr></table></td></tr></table>'});
async function api(route,body,params={}){
 if(preview){if(!window.SendzadTemplateDemo)throw Error('Template preview adapter is unavailable.');return window.SendzadTemplateDemo.request(route,body,params);}
 const response=await fetch(`template-api.php?${new URLSearchParams({r:route,...params})}`,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':state.ctx.S.csrf},body:body===undefined?undefined:JSON.stringify(body)});
 let data;try{data=await response.json();}catch{throw Error('Save response was interrupted. Reload the saved template before repeating the action.');}
 if(!response.ok)throw Error(data.error||'Template action failed.');return data;
}
function notice(message,error=false){const n=$('#sz-message');if(n){n.hidden=false;n.className=error?'error sz-notice':'sz-notice';n.textContent=message;}else state.ctx.toast(message);}
function status(message){const n=$('#sz-save-state');if(n)n.textContent=message;}
function mark(){state.ctx.S.dirty=true;state.change++;status('Unsaved changes');}
function detach(html){const d=new DOMParser().parseFromString(html,'text/html');d.querySelectorAll('[data-tz-header],[data-tz-footer]').forEach(n=>{n.setAttribute('data-tz-block',n.hasAttribute('data-tz-header')?'header':'footer');n.removeAttribute('data-tz-header');n.removeAttribute('data-tz-footer');n.removeAttribute('contenteditable');});return d.body.innerHTML;}
function safeURL(value,image=false){if(!image&&['{{website_url}}','{{unsubscribe_url}}'].includes(value))return true;try{const u=new URL(value);return !u.username&&!u.password&&(image?u.protocol==='https:':['https:','http:','mailto:','tel:'].includes(u.protocol));}catch{return false;}}
function clean(html){
 const d=new DOMParser().parseFromString(html,'text/html');
 d.querySelectorAll('script,style,iframe,object,embed,form,input,button,textarea,select,base,link,meta,svg,math,title').forEach(n=>n.remove());
 for(const n of d.querySelectorAll('*'))for(const a of [...n.attributes]){
  if(a.name.startsWith('on')||['srcdoc','srcset','contenteditable','autofocus','formaction','target','id'].includes(a.name))n.removeAttribute(a.name);
  if(['href','src','background'].includes(a.name)&&!safeURL(a.value,a.name!=='href'))n.removeAttribute(a.name);
  if(a.name==='style'&&/url\s*\(|expression|javascript|behavior|@import|\\/i.test(a.value))n.removeAttribute('style');
  if(a.name==='data-sz-selected')n.removeAttribute(a.name);
 }
 return detach(d.body.innerHTML);
}
function remember(){const html=state.record.html;if(state.history[state.position]===html)return;state.history=state.history.slice(0,state.position+1);state.history.push(html);if(state.history.length>40)state.history.shift();state.position=state.history.length-1;}
function sync(){
 if(!state.record)return;
 if(state.mode==='html'&&$('#sz-html'))state.record.html=$('#sz-html').value;
 else if(state.mode==='design'&&$('#sz-frame')?.contentDocument?.body)state.record.html=clean($('#sz-frame').contentDocument.body.innerHTML);
 for(const key of ['name','category','subject','preheader','text_body']){const n=$('#sz-'+key);if(n)state.record[key]=n.value;}
}
async function task(fn){
 if(state.busy)return;state.busy=true;
 const controls=$$('main button,main input,main textarea,main select').map(n=>[n,n.disabled]);controls.forEach(([n])=>n.disabled=true);
 const doc=$('#sz-frame')?.contentDocument;if(doc?.body)doc.body.contentEditable='false';
 try{await fn();}catch(e){notice(e.message,true);}finally{state.busy=false;controls.forEach(([n,v])=>{if(n.isConnected)n.disabled=v;});if(doc?.body&&state.mode==='design')doc.body.contentEditable='true';}
}
const tabs=(active)=>`<nav class="sz-tabs" aria-label="Email settings sections">${[['smtp','SMTP accounts'],['identity','Brand & sender details'],['verification','Verification'],['delivery','Delivery & tracking']].map(([id,label])=>`<a href="#email-settings/${id}" ${active===id?'aria-current="page"':''}>${label}</a>`).join('')}</nav>`;
async function library(section){
 const c=state.ctx;const starter=section==='starter',archived=section==='archived';
 $('#main').innerHTML=c.head('Templates','Reusable designs. Campaigns keep their own copies.',button('+ New template','new',true))+`<nav class="sz-tabs" aria-label="Template collections"><a href="#templates" ${!starter&&!archived?'aria-current="page"':''}>Saved templates</a><a href="#templates/starter" ${starter?'aria-current="page"':''}>Starter designs</a><a href="#templates/archived" ${archived?'aria-current="page"':''}>Archived</a></nav><div id="sz-message" hidden role="status"></div><div class="sz-library-tools"><label class="search">${c.icon('search')}<input id="sz-search" type="search" placeholder="Search templates" aria-label="Search templates"></label><span id="sz-library-count" class="muted"></span></div><section id="sz-library" class="panel"><div class="loading">Loading templates...</div></section><div id="sz-pages" class="sz-pagination"></div>`;
 let timer,request=0,page=1;
 async function show(){const turn=++request;const search=$('#sz-search')?.value||'';
  try{
   if(starter){await c.LIB.load();if(c.S.seq!==c.seq||turn!==request)return;const list=c.LIB.templates.filter(t=>(t.name+' '+t.category).toLowerCase().includes(search.toLowerCase()));
    $('#sz-library').className='sz-starters';$('#sz-library-count').textContent=`${list.length} designs`;
    $('#sz-library').innerHTML=list.map(t=>`<article class="panel sz-starter"><div class="sz-thumb"><iframe title="${escape(t.name)} preview" sandbox="" loading="lazy" data-sz-thumb="${escape(t.id)}" tabindex="-1"></iframe></div><div class="sz-starter-info"><span class="muted">${escape(t.category)}</span><h2>${escape(t.name)}</h2><div class="actions">${button('Preview','starter-preview',false,`data-id="${escape(t.id)}"`)}${button('Customize','starter-edit',false,`data-id="${escape(t.id)}"`)}</div></div></article>`).join('');
    const frames=$$('[data-sz-thumb]');const resize=new ResizeObserver(entries=>entries.forEach(e=>{const f=e.target.querySelector('iframe');if(f)f.style.transform=`scale(${e.contentRect.width/640})`;}));frames.forEach(f=>resize.observe(f.parentElement));state.galleryResize=resize;const load=f=>{const t=c.LIB.get(f.dataset.szThumb);f.srcdoc=c.previewHTML(c.LIB.prepare(t.html,{brand:c.S.brand,preheader:t.preheader}));f.style.transform=`scale(${f.parentElement.clientWidth/640})`;};
    if('IntersectionObserver'in window){const ob=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){load(e.target);ob.unobserve(e.target);}}),{rootMargin:'100px'});frames.forEach(f=>ob.observe(f));state.galleryObserver=ob;}else frames.forEach(load);
   }else{
    const d=await api('list',undefined,{search,page,archived:archived?1:0});if(c.S.seq!==c.seq||turn!==request)return;
    $('#sz-library-count').textContent=`${d.total} saved templates`;
    $('#sz-library').innerHTML=d.items.length?`<div class="table-scroll"><table><thead><tr><th>Name</th><th>Category</th><th>Updated</th><th>Revision</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${d.items.map(t=>`<tr><td><a href="#template-editor/${t.id}" class="row-link">${escape(t.name)}</a><span class="secondary-line">${escape(t.subject||'No subject')}</span></td><td data-label="Category">${escape(t.category||'General')}</td><td data-label="Updated">${c.D(t.updated_at)}</td><td data-label="Revision">${t.revision}</td><td class="actions">${archived?button('Restore','unarchive',false,`data-id="${t.id}" data-revision="${t.revision}"`):`<a class="btn small" href="#template-editor/${t.id}">Edit</a><details class="row-menu"><summary class="icon-btn" aria-label="Actions for ${escape(t.name)}">${c.icon('more')}</summary><div class="menu-pop">${button('Create campaign','use',false,`data-id="${t.id}" data-revision="${t.revision}"`)}${button('Duplicate','duplicate',false,`data-id="${t.id}"`)}${button('Archive','archive',false,`data-id="${t.id}" data-revision="${t.revision}"`)}</div></details>`}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><h2>${archived?'No archived templates':'No saved templates yet'}</h2><p>${archived?'Archived designs stay separate from active templates.':'Create a template or customize a starter design.'}</p></div>`;
    $('#sz-pages').innerHTML=`${button('Previous','previous',false,page===1?'disabled':'')}<span>Page ${page} of ${Math.max(1,Math.ceil(d.total/30))}</span>${button('Next','next',false,page*30>=d.total?'disabled':'')}`;
    $('#sz-pages').onclick=e=>{const n=e.target.closest('[data-sz]');if(n){page+=n.dataset.sz==='next'?1:-1;show();}};
   }
  }catch(e){notice(e.message,true);$('#sz-library').innerHTML='';}
 }
 $('#sz-search').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{page=1;show();},180);};await show();
}
async function editor(id){
 const c=state.ctx;await c.LIB.load();if(c.S.seq!==c.seq)return;
 const record=id?(await api('get',undefined,{id})).template:(state.seed||blank());state.seed=null;
 if(c.S.seq!==c.seq)return;
 state.record={...record,html:detach(record.html)};state.mode='design';state.selected=null;state.history=[state.record.html];state.position=0;c.S.dirty=!id;state.change=0;
 $('#main').innerHTML=c.head(id?'Edit template':'New template','',`<a class="btn" href="#templates">Back</a><details class="row-menu"><summary class="btn">Actions ${c.icon('down')}</summary><div class="menu-pop">${button('Save a copy','save-copy')}${button('Export HTML','export')}${id?button('Version history','history')+button('Create campaign','use-current'):''}</div></details>${button('Save template','save',true)}`)+`<div id="sz-message" role="status" hidden></div><section class="panel sz-metadata"><label class="field">Template name<input id="sz-name" maxlength="120" value="${escape(record.name)}"></label><label class="field">Category<input id="sz-category" maxlength="60" value="${escape(record.category)}" placeholder="Newsletter, promotion..."></label><label class="field">Default subject<input id="sz-subject" maxlength="200" value="${escape(record.subject)}"></label><label class="field">Preview text<input id="sz-preheader" maxlength="250" value="${escape(record.preheader)}"></label></section><section class="panel sz-studio"><div class="sz-editor-bar"><div class="segmented" aria-label="Template editing mode">${['design','html','preview'].map(m=>button(m==='html'?'HTML':m[0].toUpperCase()+m.slice(1),'mode',false,`data-mode="${m}" aria-pressed="${state.mode===m}"`)).join('')}</div><div class="actions"><label class="btn small">Import HTML<input id="sz-import" type="file" accept=".html,.htm,text/html" hidden></label>${button('Desktop','device',false,'data-mode="desktop" aria-label="Desktop template preview"')}${button('Mobile','device',false,'data-mode="mobile" aria-label="Mobile template preview"')}</div></div><div class="sz-editor-tools" id="sz-tools">${[['bold','Bold'],['italic','Italic'],['underline','Underline']].map(([x,y])=>button(y,'format',false,`data-command="${x}"`)).join('')}${button('Undo','undo')}${button('Redo','redo')}${button('Insert content','insert')}<label class="sr-only" for="sz-block">Section type</label><select id="sz-block">${c.LIB.blocks.map(b=>`<option value="${escape(b.id)}">${escape(b.name)}</option>`).join('')}</select>${button('+ Add section','add-block')}</div><div class="sz-editor-layout"><div id="sz-canvas" class="sz-canvas"></div><aside class="sz-properties" id="sz-inspector"><h2>Element properties</h2><p class="muted">Select text, a button or an image in the design.</p><div id="sz-properties"></div><div class="sz-block-tools"><h3>Selected section</h3><div class="actions">${button('Up','block-up')}${button('Down','block-down')}${button('Duplicate','block-copy')}${button('Remove','block-remove')}</div></div></aside></div><div class="form-foot"><span id="sz-save-state">${id?'Saved - revision '+record.revision:'Unsaved template'}</span><span>Headers and footers are editable.</span></div></section><details class="panel sz-plain"><summary>Plain-text alternative</summary><label class="field"><span class="sr-only">Plain-text alternative</span><textarea id="sz-text_body" rows="7">${escape(record.text_body)}</textarea></label>${button('Generate from design','text')}</details><p class="sz-footnote">Sending preserves required unsubscribe and business-address details. Saving a template never sends email.</p>`;
 for(const key of ['name','category','subject','preheader','text_body'])$('#sz-'+key).oninput=mark;
 $('#sz-import').onchange=async e=>{const f=e.target.files[0];if(!f)return;if(f.size>500000){notice('Keep HTML under 500 KB.',true);return;}if(c.S.dirty&&!confirm('Replace this template design?'))return;sync();state.record.html=clean(await f.text());remember();mark();mount();};
 mount();
}
function mount(){
 const c=state.ctx;const host=$('#sz-canvas');if(!host)return;state.selected=null;$('#sz-properties').innerHTML='';
 $('#sz-tools').hidden=state.mode!=='design';$('#sz-inspector').hidden=state.mode!=='design';host.parentElement.classList.toggle('sz-preview-only',state.mode!=='design');
 if(state.mode==='html'){host.innerHTML=`<textarea id="sz-html" class="sz-html" aria-label="Template HTML source" spellcheck="false">${escape(state.record.html)}</textarea>`;$('#sz-html').oninput=()=>{state.record.html=$('#sz-html').value;mark();};return;}
 host.innerHTML=`<iframe id="sz-frame" title="${state.mode==='design'?'Editable template':'Template preview'}" sandbox="${state.mode==='design'?'allow-same-origin':''}" class="${state.device==='mobile'?'sz-mobile':''}"></iframe>`;
 let html=clean(state.record.html);
 if(state.mode==='preview')html=html.replace(/\{\{(brand_name|website_url|postal_address|permission_reminder|year|preheader|first_name|name|email|unsubscribe_url)\}\}/g,(_,key)=>escape(({brand_name:c.S.brand?.name||'Your company',website_url:c.S.brand?.website||'https://example.com',postal_address:c.S.brand?.postal_address||'Business postal address',permission_reminder:c.S.brand?.permission_reminder||'Unsubscribe below.',year:new Date().getFullYear(),preheader:state.record.preheader,first_name:'Alex',name:'Alex Morgan',email:'alex@example.com',unsubscribe_url:'https://example.invalid/unsubscribe-preview'})[key]));
 const f=$('#sz-frame');f.onload=()=>{
  if(state.mode!=='design'||!f.contentDocument)return;const d=f.contentDocument;d.body.contentEditable='true';
  d.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();select(e.target);});
  d.addEventListener('input',()=>{state.record.html=clean(d.body.innerHTML);remember();mark();});
  d.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();}});
 };f.srcdoc=c.previewHTML(html);
}
function select(el){
 if(!(el instanceof $('#sz-frame').contentWindow.HTMLElement))return;
 state.selected=el.closest('img,a,p,h1,h2,h3,h4,td,div,span,strong,li')||el;
 const n=state.selected;const tag=n.tagName.toLowerCase();const s=n.style;
 const field=(name,label,value,type='text')=>`<label class="field">${label}<input name="${name}" type="${type}" value="${escape(value||'')}"></label>`;
 $('#sz-properties').innerHTML=`<form id="sz-property-form"><p class="sz-element-label">${escape(tag)}</p>${tag==='img'?field('src','Image URL',n.getAttribute('src'))+field('alt','Alternative text',n.getAttribute('alt')):''}${tag==='a'?field('href','Link URL',n.getAttribute('href')):''}${field('color','Text colour',s.color||'')}${field('background-color','Background colour',s.backgroundColor||'')}${field('font-size','Font size',s.fontSize||'')}${field('font-family','Font family',s.fontFamily||'')}${field('padding','Padding',s.padding||'')}${field('width','Width',s.width||(n.getAttribute('width')?n.getAttribute('width')+'px':''))}${field('text-align','Alignment',s.textAlign||'')}<button class="btn" type="submit">Apply properties</button></form>`;
 $('#sz-property-form').onsubmit=e=>{e.preventDefault();if(!state.selected?.isConnected)return;const data=new FormData(e.target);
  for(const key of ['src','href'])if(data.has(key)&&!safeURL(String(data.get(key)),key==='src')){notice('Use a valid link; images must use HTTPS.',true);return;}
  for(const key of ['color','background-color','font-size','font-family','padding','width','text-align']){const value=String(data.get(key)||'');if(value&&(/url|expression|javascript|behavior|@|[<>\\]/i.test(value)||!CSS.supports(key,value))){notice('Check '+key+'. Use a supported CSS value such as 16px or #172b4d.',true);return;}}
  for(const key of ['src','href','alt'])if(data.has(key))n.setAttribute(key,String(data.get(key)));
  for(const key of ['color','background-color','font-size','font-family','padding','width','text-align']){const value=String(data.get(key)||'');if(value)n.style.setProperty(key,value);else n.style.removeProperty(key);}
  sync();remember();mark();notice('Properties updated.');
 };
}
function block(){const el=state.selected;return el?.closest('[data-tz-block]')||el?.closest('p,h1,h2,h3,table,div');}
async function save(copy=false){
 if(state.busy)return;sync();if(!state.record?.name.trim()){notice('Name this template.',true);return;}
 await task(async()=>{const submitted={...state.record,html:clean(state.record.html)};if(copy){delete submitted.id;delete submitted.revision;submitted.name=submitted.name.slice(0,110)+' (copy)';}
  const creating=!state.record.id||copy;const result=await api('save',submitted);state.record=result.template;state.ctx.S.dirty=false;history.replaceState(null,'','#template-editor/'+result.template.id);state.ctx.S.route='template-editor/'+result.template.id;status('Saved - revision '+result.template.revision);if(creating)await editor(result.template.id);notice('Template saved.');
 });
}
async function use(id,revision){await task(async()=>{const r=await api('use',{id,revision:Number(revision)});state.ctx.S.draft=null;state.ctx.S.dirty=false;state.ctx.nav('composer/'+r.campaign.id);});}
async function emailSettings(section='smtp'){
 const c=state.ctx;section=['smtp','identity','verification','delivery'].includes(section)?section:'smtp';
 if(section==='smtp'){
  await c.senders(c.seq);if(c.S.seq!==c.seq)return;
  const heading=$('#main .page-head');if(heading){$('h1',heading).textContent='Email settings';const p=$('p',heading);if(p)p.textContent='SMTP accounts';heading.insertAdjacentHTML('afterend',tabs(section));}
  return;
 }
 const d=await c.api('settings');if(c.S.seq!==c.seq)return;
 $('#main').innerHTML=c.head('Email settings','')+tabs(section)+'<div id="sz-message" role="status" hidden></div><div id="sz-settings-body"></div>';
 const host=$('#sz-settings-body');
 if(section==='identity'){
  const b={...c.LIB.brandData(d.brand),postal_address:d.postal_address};
  const fields=[['name','Business name','text'],['website','Website','url'],['logo_url','Logo URL','url'],['support_email','Support email','email'],['phone','Contact phone','text'],['privacy_url','Privacy page','url'],['preferences_url','Preferences page','url'],['facebook_url','Facebook','url'],['instagram_url','Instagram','url'],['linkedin_url','LinkedIn','url']];
  host.innerHTML=`<form class="panel sz-settings-form" id="sz-identity-form"><div class="panel-head"><h2>Brand and contact details</h2></div><div class="form-section"><div class="form-grid">${fields.map(([key,label,type])=>`<label class="field">${label}<input name="${key}" type="${type}" maxlength="${key==='name'?120:2048}" value="${escape(b[key])}"></label>`).join('')}<label class="field span-2">Business postal address<textarea name="postal_address" rows="3" maxlength="1000">${escape(b.postal_address)}</textarea></label><label class="field span-2">Unsubscribe reminder<textarea name="permission_reminder" rows="2" maxlength="700">${escape(b.permission_reminder)}</textarea></label></div></div><div class="sz-settings-save"><button class="btn primary" type="submit">Save brand details</button></div></form>`;
  $('#sz-identity-form').oninput=()=>{c.S.dirty=true;};
  $('#sz-identity-form').onsubmit=e=>{e.preventDefault();const brand=Object.fromEntries(new FormData(e.target));task(async()=>{await c.api('settings',{brand,postal_address:brand.postal_address});c.S.brand=brand;c.S.dirty=false;notice('Brand details saved.');});};
 }else if(section==='verification'){
  host.innerHTML=`<section class="panel sz-settings-form"><div class="panel-head"><h2>Verification providers</h2></div><div class="form-section"><h3>Sendzad engine</h3><p class="muted">The independent verifier can run on the same server. Deployment and application routing must be verified before activation.</p></div><form id="sz-verification-form"><div class="form-section"><h3>Reoon connection</h3><label class="field">API key<input type="password" name="reoon_key" autocomplete="new-password" placeholder="${d.reoon_configured?'Saved - leave blank to keep':'Enter API key'}"></label><p class="muted">Saving credentials does not start a check or switch an existing job.</p></div><div class="sz-settings-save"><button class="btn primary" type="submit">Save verification settings</button></div></form></section>`;
  $('#sz-verification-form').onsubmit=e=>{e.preventDefault();const key=new FormData(e.target).get('reoon_key');task(async()=>{await c.api('settings',{reoon_key:key});e.target.reset();notice('Verification credentials saved.');});};
 }else{
  const heartbeat=(label,value)=>`<div class="health-row"><span>${label}</span><strong>${c.health(value)?'Connected':'No recent heartbeat'}</strong></div>`;
  host.innerHTML=`<section class="panel sz-settings-form"><div class="panel-head"><h2>Delivery and tracking</h2></div><div class="form-section"><p class="muted">Open and click tracking are chosen per campaign. They are estimates, not read receipts.</p>${heartbeat('Sending worker',d.sending_heartbeat)}${heartbeat('Verification worker',d.verification_heartbeat)}<div class="health-row"><span>SMTP transport</span><strong>${d.transport_installed?'Installed':'Installation required'}</strong></div></div><div class="form-section"><h3>SendGrid event webhook</h3><p class="muted">Configure signed delivery events and the public verification key in the SMTP account.</p><code class="sz-code">${escape(d.app_url)}/events.php?account=ACCOUNT_ID</code></div><div class="form-section"><h3>Reporting definitions</h3><p><strong>Accepted:</strong> the sending server accepted the message.</p><p><strong>Delivered:</strong> a supported provider confirmed delivery to the receiving server.</p><p><strong>Opened / clicked:</strong> observed engagement signals that may include automated activity.</p></div></section>`;
 }
}
async function route(ctx){
 state.ctx=ctx;if(state.galleryResize){state.galleryResize.disconnect();state.galleryResize=null;}if(state.galleryObserver){state.galleryObserver.disconnect();state.galleryObserver=null;}
 if(['templates','template-editor','email-settings','settings','senders'].includes(ctx.route)){
  await ctx.ensureBrand();if(ctx.S.seq!==ctx.seq)return true;
  if(ctx.route==='templates')await library(ctx.id);
  else if(ctx.route==='template-editor')await editor(ctx.id);
  else await emailSettings(ctx.route==='senders'?'smtp':ctx.route==='settings'?'identity':ctx.id);
  return true;
 }
 return false;
}
function setHTML(value){state.record.html=clean(value);remember();mark();mount();}
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-sz]');if(!b||b.disabled||state.busy)return;
 const action=b.dataset.sz,id=b.dataset.id;const c=state.ctx;if(!c)return;
 try{
  if(action==='insert'){
   sync();c.modal('Insert content',`<div class="sz-insert-fields"><label class="field">Type<select name="kind"><option value="text">Text section</option><option value="image">Image</option><option value="link">Text link</option><option value="button">Button</option></select></label><label class="field">Text / image description<input name="label" maxlength="1000" required></label><label class="field">Destination / image URL<input name="url" placeholder="https://"></label><p class="muted">Inserted before the footer. Use section controls to reorder.</p><div id="sz-insert-error" role="alert"></div><button type="submit" class="btn primary">Insert</button></div>`);
   $('#dialog>form').id='sz-insert-form';
   $('#sz-insert-form').onsubmit=event=>{event.preventDefault();const form=new FormData(event.target),kind=String(form.get('kind')),label=String(form.get('label')).trim(),url=String(form.get('url')).trim();
    if(!label||kind!=='text'&&!safeURL(url,kind==='image')){$('#sz-insert-error').textContent='Enter text and a valid URL. Images require HTTPS.';return;}
    const content=kind==='image'?`<img src="${escape(url)}" alt="${escape(label)}" width="560" style="display:block;width:100%;max-width:560px;height:auto">`:kind==='text'?`<p style="margin:0;font:16px/1.6 Arial,sans-serif">${escape(label)}</p>`:`<a href="${escape(url)}" style="${kind==='button'?'display:inline-block;padding:14px 22px;background-color:#175cd3;color:#ffffff;text-decoration:none':'color:#175cd3;text-decoration:underline'}">${escape(label)}</a>`;
    const d=new DOMParser().parseFromString(state.record.html,'text/html'),html=`<table data-tz-block="${kind}" role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 0">${content}</td></tr></table>`,footer=d.querySelector('[data-tz-block="footer"]');
    if(footer)footer.insertAdjacentHTML('beforebegin',html);else(d.querySelector('[data-tz-content="main"]')||d.body).insertAdjacentHTML('beforeend',html);
    $('#dialog').close();setHTML(d.body.innerHTML);
   };return;
  }
  if(action==='new'){state.seed=blank();c.nav('template-editor');if(c.S.route==='template-editor')c.render();return;}
  if(action==='starter-edit'){await c.LIB.load();const t=c.LIB.get(id);state.seed={...blank(),name:t.name,category:t.category,subject:t.subject,preheader:t.preheader,html:detach(t.html),text_body:c.LIB.toText(t.html)};c.nav('template-editor');return;}
  if(action==='starter-preview'){await c.LIB.load();const t=c.LIB.get(id);c.modal(t.name,'<div class="sz-large-preview"><iframe id="sz-library-preview" title="Template preview" sandbox=""></iframe></div>');$('#sz-library-preview').srcdoc=c.previewHTML(c.LIB.prepare(t.html,{brand:c.S.brand,preheader:t.preheader}));return;}
  if(action==='save'||action==='save-copy'){await save(action==='save-copy');return;}
  if(action==='use'){await use(id,b.dataset.revision);return;}
  if(action==='use-current'){if(c.S.dirty){notice('Save your changes before creating a campaign.',true);return;}if(state.record.id)await use(state.record.id,state.record.revision);return;}
  if(action==='duplicate'){await task(async()=>{const r=await api('duplicate',{id});c.nav('template-editor/'+r.template.id);});return;}
  if(action==='archive'||action==='unarchive'){if(action==='archive'&&!confirm('Archive this template? Existing campaigns are unchanged.'))return;await task(async()=>{await api('archive',{id,revision:Number(b.dataset.revision),archived:action==='archive'});await c.render();});return;}
  if(action==='mode'){sync();remember();state.mode=b.dataset.mode;$$('[data-sz="mode"]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));mount();return;}
  if(action==='device'){sync();state.device=b.dataset.mode;mount();return;}
  if(action==='format'){const d=$('#sz-frame')?.contentDocument;if(d){$('#sz-frame').contentWindow.focus();d.execCommand(b.dataset.command,false);sync();remember();mark();}return;}
  if(action==='undo'||action==='redo'){sync();const next=state.position+(action==='undo'?-1:1);if(next>=0&&next<state.history.length){state.position=next;state.record.html=state.history[next];mark();mount();}return;}
  if(action==='add-block'){sync();const block=c.LIB.blocks.find(x=>x.id===$('#sz-block').value);if(!block)return;const d=new DOMParser().parseFromString(state.record.html,'text/html');const footer=d.querySelector('[data-tz-block="footer"]');if(footer)footer.insertAdjacentHTML('beforebegin',block.html);else(d.querySelector('[data-tz-content="main"]')||d.body).insertAdjacentHTML('beforeend',block.html);setHTML(d.body.innerHTML);return;}
  if(action.startsWith('block-')){const n=block();if(!n||n===n.ownerDocument.body){notice('Select a section in the design first.');return;}if(action==='block-remove')n.remove();if(action==='block-copy')n.after(n.cloneNode(true));if(action==='block-up'&&n.previousElementSibling)n.previousElementSibling.before(n);if(action==='block-down'&&n.nextElementSibling)n.nextElementSibling.after(n);sync();remember();mark();mount();return;}
  if(action==='text'){sync();const d=new DOMParser().parseFromString(clean(state.record.html),'text/html');d.querySelectorAll('br').forEach(n=>n.replaceWith(d.createTextNode('\n')));d.querySelectorAll('p,h1,h2,h3,tr').forEach(n=>n.appendChild(d.createTextNode('\n\n')));$('#sz-text_body').value=d.body.textContent.replace(/\n{3,}/g,'\n\n').trim();mark();return;}
  if(action==='export'){sync();const blob=new Blob(['<!doctype html><html><head><meta charset="utf-8"><style>'+c.LIB.css+'</style></head><body>'+clean(state.record.html)+'</body></html>'],{type:'text/html;charset=utf-8'});const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=(state.record.name.replace(/[^a-z0-9_-]/gi,'-')||'template')+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);return;}
  if(action==='history'){const r=await api('history',undefined,{id:state.record.id});c.modal('Template history',`<p>Restore creates a new revision. Campaign copies are unchanged.</p><div class="sz-history">${r.items.map(v=>`<div><span>Revision ${v.revision} &middot; ${c.DT(v.created_at)}</span>${button('Restore','restore-version',false,`data-version="${v.revision}"`)}</div>`).join('')}</div>`);return;}
  if(action==='restore-version'){if(c.S.dirty&&!confirm('Restore over your unsaved changes?'))return;await task(async()=>{const r=await api('restore',{id:state.record.id,revision:Number(state.record.revision),version:Number(b.dataset.version)});c.S.dirty=false;$('#dialog').close();state.record=r.template;await editor(r.template.id);});return;}
 }catch(error){notice(error.message,true);}
});
document.addEventListener('click',e=>{
 const a=e.target.closest('a[href^="#"]');if(!a||!state.ctx)return;const target=a.getAttribute('href').slice(1);
 if(!target||target===location.hash.slice(1))return;
 if(state.busy){e.preventDefault();e.stopImmediatePropagation();notice('Finish saving before leaving this view.');return;}
 if(state.ctx.S.dirty){e.preventDefault();e.stopImmediatePropagation();state.ctx.nav(target);}
},true);
document.addEventListener('mousedown' ,e=>{if(e.target.closest('[data-sz="format"]'))e.preventDefault();});
document.addEventListener('keydown',e=>{if(state.ctx?.route==='template-editor'&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();}});
window.SendzadEnterprise={route};
})();
