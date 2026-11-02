/* Design preview only. These synthetic records never call any live provider. */
(() => {
const now=Math.floor(Date.now()/1000),day=Math.floor(now/86400)*86400;
const id=n=>n.toString(16).padStart(32,'0');
const series=Array.from({length:30},(_,i)=>({day:day-(29-i)*86400,accepted:Math.round(620+i*25+220*Math.sin(i*.8)+110*Math.cos(i*1.7)),delivered:Math.round((620+i*25+220*Math.sin(i*.8)+110*Math.cos(i*1.7))*.972)}));
const total=series.reduce((s,x)=>s+x.accepted,0),delivered=series.reduce((s,x)=>s+x.delivered,0);
const metrics={audience:total+342,accepted:total,delivered,opened:Math.round(total*.324),machine_opens:1248,clicked:Math.round(total*.078),bounced:138,unsubscribed:42,complaints:2,failed:16,unknown:2,pending:324,suppressed:22};
const campaigns=[
{id:id(1),name:'November product update',subject:'Something new, chosen for you.',status:'completed',audience:12400,accepted:12400,delivered:12078,opened:4216,revision:1,track_opens:1,updated_at:now-7200},
{id:id(2),name:'Vendor onboarding',subject:'Your next chapter starts here.',status:'running',audience:3280,accepted:2956,delivered:2873,opened:912,revision:1,track_opens:1,updated_at:now-1800},
{id:id(3),name:'Weekend offers',subject:'A little more for less.',status:'scheduled',audience:8420,accepted:0,delivered:0,opened:0,revision:1,track_opens:1,updated_at:now-86400},
{id:id(4),name:'Community newsletter',subject:'The latest from the Sendzad team.',status:'draft',audience:0,accepted:0,delivered:0,opened:0,revision:1,track_opens:0,updated_at:now-172800},
{id:id(5),name:'October highlights',subject:'A month of ideas, stories and progress.',status:'completed',audience:10630,accepted:10630,delivered:10345,opened:3421,revision:1,track_opens:1,updated_at:now-345600}
].map(c=>({...c,created_at:c.updated_at,preheader:'Your monthly update, in one place.',html:'<div style="padding:40px;font-family:Arial,sans-serif"><p style="color:#245de8;font-weight:bold">SENDZAD</p><h1>Something new, chosen for you.</h1><p>Hi {{first_name}},</p><p>Here is what is new in our community this month. Discover useful updates and fresh ideas.</p><p>Best wishes,<br>The Sendzad team</p></div>',text_body:'Hi {{first_name}}, here is what is new this month.',track_clicks:0,interval_seconds:5,last_error:null}));
const groups=[{id:id(11),name:'Newsletter subscribers',contacts:12400,ready:12400},{id:id(12),name:'Vendor community',contacts:3420,ready:3280},{id:id(13),name:'November prospects',contacts:2150,ready:0}];
const accounts=[{id:id(21),label:'Sendzad newsletters',provider:'sendgrid',enabled:1,verified_at:now-86400,daily_limit:15000,min_interval:3,used_today:8420,usage_day:new Date().toISOString().slice(0,10),config:{host:'smtp.sendgrid.net',port:587,security:'starttls',username:'apikey',from_email:'newsletter@example.net',from_name:'Sendzad',reply_to:'',webhook_public_key:'PREVIEW PUBLIC KEY - NOT A REAL CREDENTIAL'}},{id:id(22),label:'Community updates',provider:'smtp',enabled:1,verified_at:now-86400,daily_limit:5000,min_interval:5,used_today:1240,usage_day:new Date().toISOString().slice(0,10),config:{host:'smtp.example.net',port:587,security:'starttls',username:'community@example.net',from_email:'community@example.net',from_name:'Sendzad',reply_to:'',webhook_public_key:''}},{id:id(23),label:'Product announcements',provider:'smtp',enabled:1,verified_at:now-86400,daily_limit:3000,min_interval:5,used_today:620,usage_day:new Date().toISOString().slice(0,10),config:{host:'smtp.example.org',port:465,security:'tls',username:'updates@example.org',from_email:'updates@example.org',from_name:'Sendzad',reply_to:'',webhook_public_key:''}}];
const contacts=['Ada Okafor','Emeka Obi','Zainab Musa','Daniel Cole','Grace Adeyemi','Samuel James','Fatima Bello','Tomi George'].map((name,i)=>({id:i+1,email:name.toLowerCase().replace(' ','.')+'@example.net',name,consent:1,verification:['valid','valid','valid','unverified','risky','unknown','valid','invalid'][i],verified_at:i===3?null:now-86400,suppressed:0}));
const jobs=[{id:id(31),name:'Newsletter list check',status:'completed',total:12800,valid:12400,invalid:208,risky:128,unknown:64,remaining:0,updated_at:now-7200,last_error:null},{id:id(32),name:'Vendor community check',status:'running',total:3420,valid:2140,invalid:45,risky:20,unknown:15,remaining:1200,updated_at:now-60,last_error:null},{id:id(33),name:'November prospects',status:'ready',total:2150,valid:0,invalid:0,risky:0,unknown:0,remaining:2150,updated_at:now-18000,last_error:null}];
const recipients=contacts.map((c,i)=>({...c,id:id(100+i),status:i===7?'failed':'accepted',delivered_at:i<6?now-7200+i*30:null,opened_at:i<4?now-6800+i*50:null,clicked_at:i<2?now-6500+i*40:null,bounced_at:null,error:i===7?'Recipient rejected by provider.':null}));
const demoBrand={name:'Sendzad',website:'https://sendzad.com',logo_url:'',support_email:'',phone:'',postal_address:'Sample address - design preview only',privacy_url:'',preferences_url:'',facebook_url:'',instagram_url:'',linkedin_url:'',permission_reminder:'To stop receiving these messages, use the unsubscribe link below.'};
const findCampaign=id=>campaigns.find(c=>c.id===id)||campaigns[0];
function clone(v){return JSON.parse(JSON.stringify(v));}
window.SendzadDemo={async request(route,body,params={}){
    await new Promise(r=>setTimeout(r,45));
    if(body!==undefined){
        if(route==='campaigns'){const c={...body,id:body.id||id(Date.now()),status:'draft',revision:Number(body.revision||0)+1,updated_at:now,audience:0,accepted:0,delivered:0,opened:0};const i=campaigns.findIndex(x=>x.id===c.id);if(i<0)campaigns.unshift(c);else campaigns[i]=c;return clone({campaign:c});}
        if(route==='campaign/duplicate'){const c={...findCampaign(body.id),id:id(Date.now()),name:findCampaign(body.id).name+' (copy)',status:'draft',revision:1};campaigns.unshift(c);return clone({campaign:c});}
        if(route==='groups'){const g={id:id(Date.now()),name:body.name,contacts:0,ready:0};groups.push(g);return clone({group:g});}
        if(route==='contacts/import')return {added:body.rows.length,duplicates:0,invalid:0};
        if(route==='jobs/add-valid')return {added:12400};
        if(route==='logout')return {ok:true};
        if(route==='settings'){Object.assign(demoBrand,body.brand||{},{postal_address:body.postal_address||demoBrand.postal_address});return {ok:true};}
        if(route==='jobs'){jobs.unshift({id:id(Date.now()),name:body.name,status:'ready',total:100,valid:0,invalid:0,risky:0,unknown:0,remaining:100,updated_at:now});return {ok:true};}
        throw new Error('Design preview only. Install the PHP application to use this action. No messages were sent.');
    }
    if(route==='session')return {authenticated:true,csrf:'preview-only'};
    if(route==='overview')return clone({metrics,series,campaigns:campaigns.slice(0,5),contacts:17970,ready_contacts:15680,enabled_accounts:3,sending_heartbeat:now-32,verification_heartbeat:now-44,activity:[]});
    if(route==='campaigns'){const items=campaigns.filter(c=>(!params.status||c.status===params.status)&&(!params.search||c.name.toLowerCase().includes(params.search.toLowerCase())));return clone({items,total:items.length,page:1});}
    if(route==='campaign'){const c=findCampaign(params.id);return clone({campaign:c,metrics:{...metrics,audience:c.audience,accepted:c.accepted,delivered:c.delivered,opened:c.opened,clicked:Math.round(c.opened*.24),pending:c.status==='running'?324:0}});}
    if(route==='groups')return clone({items:groups});
    if(route==='accounts')return clone({items:accounts});
    if(route==='contacts'){const items=contacts.filter(c=>(!params.status||c.verification===params.status)&&(!params.search||`${c.email} ${c.name}`.toLowerCase().includes(params.search.toLowerCase())));return clone({items,total:items.length,page:1});}
    if(route==='jobs')return clone({items:jobs});
    if(route==='recipients'){let items=recipients.filter(r=>!params.search||r.email.includes(params.search));if(params.status==='opened')items=items.filter(r=>r.opened_at);if(params.status==='delivered')items=items.filter(r=>r.delivered_at);return clone({items,total:items.length,page:1});}
    if(route==='recipient/events')return {events:[{source:'tracking',kind:'open (estimated)',machine:0,occurred_at:now-6800},{source:'sendgrid',kind:'delivered',machine:0,occurred_at:now-7200}]};
    if(route==='campaign/preflight')return window.SendzadTemplates.preflight(findCampaign(params.id),demoBrand);
    if(route==='settings')return {brand:clone(demoBrand),postal_address:demoBrand.postal_address,reoon_configured:true,app_url:'https://campaigns.example.com',sending_heartbeat:now-32,verification_heartbeat:now-44,transport_installed:true};
    throw new Error('This preview view is unavailable.');
}};
})();
