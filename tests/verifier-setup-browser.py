"""Offline interaction tests for the actual PHP connection UI module; no campaigns."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json
ROOT=Path(__file__).resolve().parents[1]
script=(ROOT/'shared-hosting/public/assets/verification-connection.js').read_text()
results=[]
def check(name,condition):
    assert condition,name
    results.append(name)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page()
    page.route('**/*',lambda route:route.abort())
    page.set_content('<main id="main"></main><dialog id="dialog"></dialog>')
    page.evaluate('''() => {
      window.calls=[]; window.connection={configured:false,message:'Set the private server address.',service_url:''};
      window.SendzadEnterprise={route:async()=>{window.previousCalled=true;return false;}};
      window.ctx={route:'email-settings',id:'verification',seq:1,S:{seq:1},
        api:async(route,body)=>{calls.push({route,body});if(route==='self/settings')return connection;
          if(route==='settings')return {reoon_configured:false};if(route==='self/check'){if(window.failCheck)throw Error('Service unavailable');return {engine:'sendzad'};}
          if(route==='groups')return {items:[{id:'group-fixture',name:'Synthetic group'}]};if(route==='jobs')return {items:[]};return {};},
        head:(title,subtitle,actions='')=>'<h1>'+title+'</h1>'+actions,N:n=>String(n),
        render:async()=>{},toast:()=>{}};
    }''')
    page.add_script_tag(content=script)
    page.evaluate('SendzadEnterprise.route(ctx)')
    check('missing configuration disables service test',page.locator('#sv-check').is_disabled())
    check('setup reason visible',page.locator('#sv-setup-help').inner_text()=='Set the private server address.')
    page.locator('summary').click()
    check('same-server instructions available','self_verifier_mode' in page.locator('main').inner_text())
    check('doctor command visible','verifier-doctor.php' in page.locator('main').inner_text())
    page.evaluate("connection={configured:true,mode:'local',service_url:'http://127.0.0.1:8095',message:'Configured, test required.'};SendzadEnterprise.route(ctx)")
    check('local mode displayed','Same server' in page.locator('main').inner_text())
    check('configuration is not labelled tested','not yet connection-tested' in page.locator('main').inner_text())
    page.locator('#sv-check').click()
    page.wait_for_function("document.querySelector('#sv-message').textContent.includes('acceptance')")
    check('one explicit health request only',page.evaluate("calls.filter(x=>x.route==='self/check').length")==1)
    page.evaluate('window.failCheck=true')
    page.locator('#sv-check').click()
    page.wait_for_function("document.querySelector('#sv-message').textContent==='Service unavailable'")
    check('error recoverable and no silent fallback',not page.locator('#sv-check').is_disabled() and page.evaluate("calls.filter(x=>x.route==='jobs/control').length")==0)
    page.evaluate("ctx.route='verification';ctx.id='';SendzadEnterprise.route(ctx)")
    page.locator('#sv-new').click()
    check('new lists default to Sendzad',page.locator('[name=provider]').input_value()=='sendzad')
    page.locator('[name=name]').fill('Saved without starting')
    page.locator('[name=group_id]').select_option('group-fixture')
    page.locator('#sv-create button[type=submit]').click()
    page.wait_for_function("calls.some(x=>x.route==='jobs'&&x.body?.name==='Saved without starting')")
    check('saving does not launch a job',page.evaluate("calls.filter(x=>x.route==='jobs/control').length")==0)
    page.evaluate("ctx.route='templates';SendzadEnterprise.route(ctx)")
    check('unrelated views preserved',page.evaluate('window.previousCalled') is True)
    browser.close()
print(json.dumps({'passed':len(results),'failed':0,'tests':results,'scope':'offline synthetic API interaction; not deployed PHP'},indent=2))
