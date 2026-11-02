'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaults={name:'',website:'',logo_url:'',support_email:'',phone:'',postal_address:'',privacy_url:'',preferences_url:'',facebook_url:'',instagram_url:'',linkedin_url:'',permission_reminder:'To stop receiving these messages, use the unsubscribe link below.'};
const mergeKeys=['email','name','first_name','brand_name','website_url','postal_address','permission_reminder','year','preheader','unsubscribe_url'];
const safeHttps=s=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&!/[\x00-\x20\x7f]/.test(s)?u.href:'';}catch{return '';}};
const validMail=s=>/^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(s);
const brandData=b=>({...defaults,...b});
const anchor=(text,url)=>`<a href="${esc(url)}" style="font-family:Arial,Helvetica,sans-serif;color:#34594f;text-decoration:underline;font-size:13px;line-height:1.8">${esc(text)}</a>`;
const small=s=>`<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.8;color:#51616b">${s}</p>`;
function header(b){
 b=brandData(b);const site=safeHttps(b.website),logo=safeHttps(b.logo_url);
 const identity=logo?`<img src="${esc(logo)}" width="144" alt="${esc(b.name)}" style="display:block;width:144px;max-width:100%;height:auto;border:0">`:`<strong style="font-family:Arial,Helvetica,sans-serif;font-size:24px;letter-spacing:-1px;color:#173e38">${esc(b.name||'Your brand')}</strong>`;
 return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" data-tz-header="standard"><tr><td style="padding:27px 0">${site?`<a href="${esc(site)}" style="text-decoration:none">${identity}</a>`:identity}</td><td align="right" class="tz-utility" style="padding:27px 0;text-align:right">${site?anchor('Visit website',site):''}</td></tr></table>`;
}
function footer(b,unsubscribe='{{unsubscribe_url}}',year=new Date().getFullYear()){
 b=brandData(b);const contact=[],social=[],legal=[];
 if(validMail(b.support_email))contact.push(anchor(b.support_email,'mailto:'+b.support_email));
 if(b.phone)contact.push(esc(b.phone));
 for(const [field,label] of [['facebook_url','Facebook'],['instagram_url','Instagram'],['linkedin_url','LinkedIn']])if(safeHttps(b[field]))social.push(anchor(label,b[field]));
 for(const [field,label] of [['privacy_url','Privacy'],['preferences_url','Email preferences']])if(safeHttps(b[field]))legal.push(anchor(label,b[field]));
 legal.push(anchor('Unsubscribe',unsubscribe));
 return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" data-tz-footer="standard"><tr><td style="padding:28px 0;border-top:1px solid #dce4e2">${small(`<strong style="color:#172d37;font-size:15px">${esc(b.name||'Your brand')}</strong>`)}${small(esc(b.postal_address||'[Add your postal address in Settings]').replace(/\n/g,'<br>'))}${contact.length?small(contact.join(' &nbsp; | &nbsp; ')):''}${social.length?small(social.join(' &nbsp; / &nbsp; ')):''}${small(esc(b.permission_reminder))}${small(legal.join(' &nbsp; | &nbsp; '))}${small('&copy; '+year+' '+esc(b.name||'Your brand')+'. All rights reserved.')}</td></tr></table>`;
}
function replaceModules(doc,b,{editing=false,unsubscribe='{{unsubscribe_url}}'}={}){
 for(const [key,html] of [['header',header(b)],['footer',footer(b,unsubscribe)]]){
  const nodes=[...doc.querySelectorAll(`[data-tz-${key}]`)];
  nodes.forEach((n,i)=>{if(i){n.remove();return;}const tmp=doc.createElement('div');tmp.innerHTML=html;const next=tmp.firstElementChild;if(editing){next.contentEditable='false';next.title='Managed in Brand settings';}n.replaceWith(next);});
 }
}
function values(b,preheader,recipient,unsubscribe){return {brand_name:b.name||'Your brand',website_url:safeHttps(b.website),postal_address:b.postal_address,permission_reminder:b.permission_reminder,year:String(new Date().getFullYear()),preheader:preheader||'',email:recipient?.email||'reader@example.net',name:recipient?.name||'there',first_name:recipient?.name?.trim().split(/\s+/)[0]||'there',unsubscribe_url:unsubscribe};}
function interpolate(s,vars,html=true){return s.replace(/\{\{([a-z_]+)\}\}/g,(whole,key)=>Object.hasOwn(vars,key)?(html?esc(vars[key]):vars[key]):whole);}
function body(html){return new DOMParser().parseFromString(html,'text/html').body.innerHTML;}
function prepare(html,{brand={},preheader='',editing=false,recipient=null,unsubscribe='https://example.invalid/unsubscribe-preview'}={}){
 const b=brandData(brand),doc=new DOMParser().parseFromString(html,'text/html');
 doc.querySelectorAll('head,script,style').forEach(n=>n.remove());
 replaceModules(doc,b,{editing,unsubscribe});
 doc.querySelectorAll('[data-tz-preheader]').forEach(n=>n.remove());
 if(editing)return doc.body.innerHTML;
 const vars=values(b,preheader,recipient,unsubscribe),s=interpolate(doc.body.innerHTML,vars);
 return `<div data-tz-preheader="standard" class="tz-preheader" style="display:none;max-height:0;overflow:hidden">${esc(interpolate(preheader,vars,false))}</div>`+s;
}
function serialize(doc){
 const node=doc.body.cloneNode(true);
 for(const key of ['header','footer'])node.querySelectorAll(`[data-tz-${key}]`).forEach((el,i)=>{if(i){el.remove();return;}el.outerHTML=catalog[key];});
 node.querySelectorAll('[contenteditable]').forEach(n=>n.removeAttribute('contenteditable'));
 node.querySelectorAll('[data-tz-preheader]').forEach(n=>n.remove());
 return node.innerHTML;
}
function toText(html){
 const doc=new DOMParser().parseFromString(html,'text/html');
 doc.querySelectorAll('head,script,style,[data-tz-header],[data-tz-footer],[data-tz-preheader]').forEach(n=>n.remove());
 doc.querySelectorAll('a[href]').forEach(n=>{const href=n.getAttribute('href');if(href&&!href.includes('unsubscribe'))n.append(doc.createTextNode(` (${href})`));});
 doc.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));
 doc.querySelectorAll('p,h1,h2,h3,h4,li,tr,div,table').forEach(n=>n.append(doc.createTextNode('\n\n')));
 return doc.body.textContent.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function exampleHost(url){try{const host=new URL(url).hostname.toLowerCase();return /(^|\.)(example\.(com|net|org)|localhost)$/.test(host)||/\.(invalid|test|example)$/.test(host);}catch{return false;}}
function preflight(draft,brand={}){
 const b=brandData(brand),doc=new DOMParser().parseFromString(draft.html||'','text/html'),errors=[],warnings=[];
 doc.querySelectorAll('head,script,style,[data-tz-header],[data-tz-footer],[data-tz-preheader]').forEach(n=>n.remove());
 const visible=[draft.subject,draft.preheader,draft.text_body,doc.body.textContent].join('\n');
 if(!b.name.trim())errors.push('Add the brand name in Settings.');
 if(!b.postal_address.trim())errors.push('Add the business postal address in Settings.');
 if(/\[[^\]\n]{2,180}\]/.test(Object.values(b).join('\n')))errors.push('Replace the bracketed sample details in Brand settings.');
 if(b.support_email&&exampleHost('https://'+b.support_email.split('@').pop()))errors.push('Replace the sample support email in Brand settings.');
 if(/\{\{website_url\}\}/.test(draft.html||'')&&!safeHttps(b.website))errors.push('Add the HTTPS website in Brand settings.');
 if(['website','logo_url','privacy_url','preferences_url','facebook_url','instagram_url','linkedin_url'].some(k=>b[k]&&exampleHost(b[k])))errors.push('Replace example URLs in Brand settings.');
 if(/\[[^\]\n]{2,180}\]/.test(visible))errors.push('Replace the bracketed sample copy in the subject, design or plain text.');
 const raw=[draft.subject,draft.preheader,draft.text_body,draft.html].join('\n');
 const unknown=[...raw.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)].map(m=>m[1]).filter(k=>!mergeKeys.includes(k));
 if(unknown.length)errors.push('Remove unsupported personalization fields.');
 if(doc.querySelector('[data-tz-placeholder="image"]'))errors.push('Replace or remove the sample image panels.');
 let broken=false,examples=false;
 doc.querySelectorAll('a').forEach(a=>{const u=a.getAttribute('href')||'';if(['{{website_url}}','{{unsubscribe_url}}'].includes(u))return;try{const parsed=new URL(u);if(!['https:','http:','mailto:','tel:'].includes(parsed.protocol)||parsed.username||parsed.password)broken=true;}catch{broken=true;}if(exampleHost(u))examples=true;});
 doc.querySelectorAll('img').forEach(i=>{const src=i.getAttribute('src')||'';if(!safeHttps(src))broken=true;if(exampleHost(src))examples=true;if(!i.hasAttribute('alt'))warnings.push('Add alternative text to each content image.');});
 if(broken)errors.push('Repair missing or unsafe links and image URLs.');
 if(examples)errors.push('Replace example-domain links and images.');
 if(doc.querySelector('img[data-sz-image="stock"]'))warnings.push('Review stock photographs to ensure they match your products and message.');
 if(!(draft.preheader||'').trim())warnings.push('Add preview text to support the subject line.');
 if(!(draft.text_body||'').trim())warnings.push('Generate the plain-text alternative.');
 if(new TextEncoder().encode(draft.html||'').length>95000)warnings.push('This design is large. Check for inbox clipping.');
 return {ready:!errors.length,errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}
const scriptURL=document.currentScript?.src;
const catalogURL=scriptURL?new URL(catalog.catalogFile,scriptURL).href:'assets/'+catalog.catalogFile;
let loading;
function load(){
 if(window.SendzadTemplates.templates.length)return Promise.resolve(window.SendzadTemplates);
 if(loading)return loading;
 loading=new Promise((resolve,reject)=>{
  function install(){
   const data=window.SendzadTemplateCatalog;
   if(!data||!Array.isArray(data.templates)||!Array.isArray(data.blocks)){loading=null;reject(new Error('The template library could not load. Retry this page.'));return;}
   Object.assign(window.SendzadTemplates,data);resolve(window.SendzadTemplates);
  }
  if(window.SendzadTemplateCatalog){install();return;}
  const el=document.createElement('script');el.src=catalogURL;el.async=true;
  el.onload=install;el.onerror=()=>{el.remove();loading=null;reject(new Error('The template library could not load. Check your connection and retry.'));};
  document.head.append(el);
 });return loading;
}

window.SendzadTemplates={...catalog,templates:[],blocks:[],load,defaults,brandData,safeHttps,header,footer,body,prepare,serialize,toText,preflight,interpolate,
 get(id){return this.templates.find(t=>t.id===id)||this.templates[0];},
 create(id){const t=this.get(id);return {name:t.name,subject:t.subject,preheader:t.preheader,html:t.html,text_body:toText(t.html),track_opens:0,track_clicks:0};}
};
