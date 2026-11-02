"""Offline frontend regression; explicit simulated script transport, no live sending."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
project=Path(__file__).resolve().parents[2]
outdir=project/'private/test-output';outdir.mkdir(exist_ok=True)
results=[]
def check(name,ok):
 results.append({'name':name,'passed':bool(ok)})
 if not ok:print('FAIL',name)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':390,'height':844})
 context.route('**/*',lambda route:route.abort())
 page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body data-preview="true"><div id="app"></div><dialog id="dialog" aria-labelledby="dialog-title"></dialog><div id="toast" role="status" hidden></div></body></html>')
 page.add_style_tag(content=(project/'public/assets/workspace.css').read_text())
 catalog=next((project/'public/assets').glob('template-catalog.*.js')).read_text()
 # Simulated transport only: this checks coalescing, not HTTP/network behavior.
 page.evaluate("""code=>{window.catalogRequests=[];const append=HTMLHeadElement.prototype.append;HTMLHeadElement.prototype.append=function(...nodes){const script=nodes.find(n=>n.tagName==='SCRIPT'&&n.src.includes('template-catalog.'));if(script){catalogRequests.push(script.getAttribute('src'));queueMicrotask(()=>{(0,eval)(code);script.onload();});return;}return append.apply(this,nodes);};}""",catalog)
 for name in ['demo.js','templates.js','workspace.js']:page.add_script_tag(content=(project/'public/assets'/name).read_text())
 page.wait_for_selector('h1')
 check('overview does not load the template catalog',len(page.evaluate('catalogRequests'))==0)
 check('platform displays Sendzad, not the old brand','sendzad' in page.inner_text('body').lower() and 'trezad' not in page.inner_text('body').lower())
 check('default business email brand is blank',page.evaluate('SendzadTemplates.defaults.name')=='')
 page.screenshot(path=str(outdir/'sendzad-mobile.png'),full_page=True)
 page.evaluate('Promise.all([SendzadTemplates.load(),SendzadTemplates.load(),SendzadTemplates.load()])')
 check('concurrent library loads share one simulated request',len(page.evaluate('catalogRequests'))==1)
 page.evaluate('location.hash="templates"');page.wait_for_selector('.professional-template');page.wait_for_timeout(250)
 initial=page.locator('iframe[data-loaded="1"]').count()
 check('mobile gallery builds only nearby preview documents',0<initial<16)
 page.locator('.professional-template').last.scroll_into_view_if_needed();page.wait_for_timeout(200)
 check('scrolling builds additional previews',page.locator('iframe[data-loaded="1"]').count()>initial)
 page.evaluate('location.hash="overview"');page.wait_for_selector('h1');page.evaluate('location.hash="templates"');page.wait_for_selector('.professional-template')
 check('revisiting the gallery reuses the catalog',len(page.evaluate('catalogRequests'))==1)
 check('all 16 built-ins contain a real photo URL',page.evaluate('SendzadTemplates.templates.every(t=>t.html.includes("https://images.unsplash.com/photo-"))'))
 check('new templates have no empty image panels',page.evaluate('SendzadTemplates.templates.every(t=>!t.html.includes("data-tz-placeholder"))'))
 check('body and subject use the business brand, not the platform',page.evaluate('SendzadTemplates.templates.every(t=>!t.html.toLowerCase().includes("sendzad")&&!t.subject.toLowerCase().includes("sendzad"))'))
 check('all photographic slots have alternative text',page.evaluate('SendzadTemplates.templates.every(t=>[...new DOMParser().parseFromString(t.html,"text/html").querySelectorAll("img")].every(i=>!!i.alt))'))
 page.set_viewport_size({'width':1440,'height':1000});page.evaluate('location.hash="overview"');page.wait_for_timeout(200);page.screenshot(path=str(outdir/'sendzad-desktop.png'),full_page=True)
 check('no uncaught JavaScript errors',not errors)
 check('runtime template asset is smaller than 16 KB',(project/'public/assets/templates.js').stat().st_size<16000)
 browser.close()
result={'checks':len(results),'passed':sum(r['passed'] for r in results),'failed':sum(not r['passed'] for r in results),'initial_mobile_iframes':initial,'results':results,'network':'Inline offline fixture; catalog transport simulated; photo requests blocked. Not an HTTP deployment or live provider test.'}
(outdir/'performance.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));raise SystemExit(1 if result['failed'] else 0)
