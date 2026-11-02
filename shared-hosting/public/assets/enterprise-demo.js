/* Synthetic browser-only template store. NEVER loaded by index.php. No real sends. */
(() => {
 const key='sendzad-template-preview-v4';let store;
 try{store=JSON.parse(localStorage.getItem(key)||'null');}catch{}
 store=store||window.SendzadPreviewSeed||{records:[],versions:{}};
 const copy=x=>JSON.parse(JSON.stringify(x));
 const persist=()=>{try{localStorage.setItem(key,JSON.stringify(store));}catch{ /* File/sandbox preview: session-only storage. */ }};
 function get(id){const t=store.records.find(t=>t.id===id);if(!t)throw Error('Template not found.');return t;}
 const fresh=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
 function save(body){if(!body.name?.trim()||!body.html)throw Error('Name the template and add content.');const old=body.id?get(body.id):null;if(old&&(old.revision!==Number(body.revision)||old.archived))throw Error('This template changed or was archived. Reload before saving.');const now=Math.floor(Date.now()/1000),t={...body,id:old?.id||fresh(),revision:(old?.revision||0)+1,archived:0,created_at:old?.created_at||now,updated_at:now};if(old)Object.assign(old,t);else store.records.push(t);store.versions[t.id]??=[];store.versions[t.id].push(copy(t));store.versions[t.id]=store.versions[t.id].slice(-20);persist();return {template:copy(t)};}
 window.SendzadTemplateDemo={snapshot:()=>copy(store),async request(route,body,params={}){
  if(route==='list'){const list=store.records.filter(t=>Number(t.archived)===Number(params.archived||0)&&(t.name+' '+t.category).toLowerCase().includes((params.search||'').toLowerCase())).sort((a,b)=>b.updated_at-a.updated_at||b.id.localeCompare(a.id));const page=Number(params.page||1);return copy({items:list.slice((page-1)*30,page*30),total:list.length,page});}
  if(route==='get')return {template:copy(get(params.id))};
  if(route==='save')return save(copy(body));
  if(route==='duplicate'){const t=copy(get(body.id));delete t.id;delete t.revision;t.name=t.name.slice(0,110)+' (copy)';return save(t);}
  if(route==='archive'){const t=get(body.id);if(t.revision!==Number(body.revision))throw Error('This template changed.');t.archived=body.archived?1:0;t.revision++;persist();return {ok:true};}
  if(route==='history')return {items:copy((store.versions[params.id]||[]).map(t=>({revision:t.revision,created_at:t.updated_at})).reverse())};
  if(route==='restore'){const t=store.versions[body.id]?.find(t=>t.revision===Number(body.version));if(!t)throw Error('Revision not found.');return save({...copy(t),revision:Number(body.revision)});}
  if(route==='use'){const t=get(body.id);if(t.archived||t.revision!==Number(body.revision))throw Error('Reload the saved template.');if(!t.subject.trim())throw Error('Add a subject to the template before creating a campaign.');const c=copy(t);delete c.id;delete c.revision;return window.SendzadDemo.request('campaigns',{...c,track_opens:false,track_clicks:false});}
  throw Error('Preview action unavailable. No messages were sent.');
 }};
})();
