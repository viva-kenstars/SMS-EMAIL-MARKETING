"""Offline browser checks of the shipped PHP connection module; synthetic API only."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
script=(root/'shared-hosting/public/assets/verification-connection.js').read_text()
fixture=r"""
window.calls=[];window.oldRoutes=[];window.errors=[];
window.addEventListener('error',e=>errors.push(e.message));
window.SendzadEnterprise={route:async c=>{oldRoutes.push(c.route);return false;}};
window.configured=true;
const groups=[{id:'b'.repeat(32),name:'Saved buyers'}];
const jobs=[{id:'a'.repeat(32),name:'Check one',engine:'sendzad',status:'ready',valid:0,remaining:2},{id:'c'.repeat(32),name:'Old paid job',engine:'reoon',status:'paused',valid:1,remaining:1},{id:'d'.repeat(32),name:'Completed <safe>',engine:'sendzad',status:'completed',valid:2,remaining:0}];
window.context=(route,id)=>({route,id,seq:1,S:{seq:1},head:(title,subtitle,actions='')=>`<div class='page-head'><h1>${title}</h1>${actions}</div>`,N:String,toast:message=>{window.lastToast=message;},render:async()=>{},api:async(route,body)=>{calls.push({route,body});if(route==='self/settings')return {configured:window.configured,service_url:window.configured?'https://verify.example.test':'',paid_fallback:false};if(route==='settings')return {reoon_configured:true};if(route==='jobs')return body?{id:'new'}:{items:jobs};if(route==='groups')return body?{group:{id:'e'.repeat(32)}}:{items:groups};if(route==='jobs/add-valid')return {added:2};if(['self/check','jobs/control'].includes(route))return {ok:true};throw Error('Unexpected API '+route);},modal:(title,html)=>{const d=document.querySelector('#dialog');d.innerHTML=html;d.showModal();}});
"""
checks=[]
def check(label,fn):
    fn();checks.append(label)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':1000})
 page.set_content('<main id="main"></main><dialog id="dialog"></dialog>')
 page.add_script_tag(content=fixture);page.add_script_tag(content=script)
 page.evaluate("SendzadEnterprise.route(context('email-settings','verification'))")
 check('separate connection settings show Sendzad default',lambda:page.get_by_text('Default for new checks').wait_for())
 check('secondary Reoon key remains password input',lambda:page.locator('input[type=password]').wait_for())
 page.locator('#sv-check').click()
 check('connection test calls only health action',lambda: (_ for _ in ()).throw(AssertionError()) if page.evaluate("calls.filter(x=>x.route==='self/check').length")!=1 else None)
 page.locator('input[name=reoon_key]').fill('fake-key-never-transmitted')
 page.locator('#sv-reoon button').click()
 check('Reoon settings save is isolated',lambda:(_ for _ in ()).throw(AssertionError()) if page.evaluate("calls.filter(x=>x.route==='settings'&&x.body).length")!=1 else None)
 page.evaluate("calls=[];SendzadEnterprise.route(context('verification'))")
 check('list exposes old and new providers',lambda:page.get_by_text('Old paid job').wait_for())
 check('result names are escaped',lambda:page.get_by_text('Completed <safe>').wait_for())
 check('only one add-verified action',lambda:(_ for _ in ()).throw(AssertionError()) if page.locator('[data-sv=add]').count()!=1 else None)
 page.locator('#sv-new').click();page.locator('[name=name]').fill('New local check');page.locator('[name=group_id]').select_option('b'*32)
 check('new check defaults self-hosted',lambda:(_ for _ in ()).throw(AssertionError()) if page.locator('[name=provider]').input_value()!='sendzad' else None)
 page.locator('#sv-create button').click()
 check('save does not start checks',lambda:(_ for _ in ()).throw(AssertionError()) if page.evaluate("calls.some(x=>x.route==='jobs/control')") else None)
 page.on('dialog',lambda d:d.accept())
 page.locator('[data-sv=start]').click()
 check('explicit start requires permission payload',lambda:(_ for _ in ()).throw(AssertionError()) if not page.evaluate("calls.some(x=>x.route==='jobs/control'&&x.body.action==='start'&&x.body.provider_consent===true)") else None)
 page.locator('[data-sv=add]').click();page.locator('#sv-group-name').fill('Clean group');page.locator('#sv-add').click()
 check('new verified group imports completed results',lambda:(_ for _ in ()).throw(AssertionError()) if not page.evaluate("calls.some(x=>x.route==='jobs/add-valid'&&x.body.group_id==='e'.repeat(32))") else None)
 page.evaluate("configured=false;SendzadEnterprise.route(context('email-settings','verification'))")
 check('unconfigured service cannot be tested',lambda:(_ for _ in ()).throw(AssertionError()) if not page.locator('#sv-check').is_disabled() else None)
 page.evaluate("SendzadEnterprise.route(context('campaigns'))")
 check('campaign and template routes are left alone',lambda:(_ for _ in ()).throw(AssertionError()) if page.evaluate("oldRoutes[0]")!='campaigns' else None)
 check('no campaign API calls',lambda:(_ for _ in ()).throw(AssertionError()) if page.evaluate("calls.some(x=>/campaign|send|smtp/.test(x.route))") else None)
 check('no uncaught browser errors',lambda:(_ for _ in ()).throw(AssertionError(str(page.evaluate('errors')))) if page.evaluate('errors') else None)
 browser.close()
print(json.dumps({'passed':len(checks),'failed':0,'cases':checks,'scope':'offline browser; mocked API; no live sends'},indent=2))
