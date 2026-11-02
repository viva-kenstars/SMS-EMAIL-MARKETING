<?php
declare(strict_types=1);
require __DIR__.'/bootstrap.php';
require dirname(__DIR__).'/app/SavedTemplates.php';
use function Sendzad\{saved_template_input,saved_template_get,saved_template_route,email_dom,custom_footer_complete,compose_email,brand_defaults};
check('template requires a name before storage',static fn()=>rejects(static fn()=>saved_template_input(['name'=>'','html'=>'x']),400));
check('template name has a bounded length',static fn()=>rejects(static fn()=>saved_template_input(['name'=>str_repeat('a',121),'html'=>'x']),400));
check('template rejects non-string HTML',static fn()=>rejects(static fn()=>saved_template_input(['name'=>'A','html'=>[]]),400));
check('template rejects oversized HTML',static fn()=>rejects(static fn()=>saved_template_input(['name'=>'A','html'=>str_repeat('a',500001)]),400));
check('record IDs are validated before query',static fn()=>rejects(static fn()=>saved_template_get('not-a-record'),400));
check('GET cannot save',static fn()=>rejects(static fn()=>saved_template_route('save','GET',[]),405));
check('POST cannot list',static fn()=>rejects(static fn()=>saved_template_route('list','POST',[]),405));
check('unsupported methods cannot mutate',static fn()=>rejects(static fn()=>saved_template_route('archive','DELETE',[]),405));
check('archive state requires boolean',static fn()=>rejects(static fn()=>saved_template_route('archive','POST',['archived'=>'false']),400));
if(!class_exists('DOMDocument')){
 $skips+=5;echo "SKIP five server-side DOM sanitizer/footer checks; enable PHP DOM.\n";
}else{
 check('template sanitization preserves editable content and removes executable content',static function(){
  $r=saved_template_input(['name'=>'Safe','html'=>'<table data-tz-header="standard"><tr><td><h2>Editable</h2></td></tr></table><script>alert(1)</script><img src="https://images.example.org/a.jpg" onerror="x()">']);
  truth(str_contains($r['html'],'Editable'));truth(!str_contains($r['html'],'data-tz-header'));truth(!str_contains($r['html'],'script'));truth(!str_contains($r['html'],'onerror'));
 });
 $b=[...brand_defaults(),'name'=>'Studio','postal_address'=>"Street One\nLagos"];$u='https://mailer.example.org/unsubscribe.php?t=signed-fixture';
 check('authored visible footer recognized across line breaks',static fn()=>truth(custom_footer_complete(email_dom('<p>Street One<br>Lagos</p><a href="'.$u.'">Leave this list</a>'),$b,$u)));
 check('hidden footer cannot substitute required details',static fn()=>eq(custom_footer_complete(email_dom('<div style="display:none"><p>Street One<br>Lagos</p><a href="'.$u.'">Leave</a></div>'),$b,$u),false));
 check('wrong unsubscribe destination does not qualify',static fn()=>eq(custom_footer_complete(email_dom('<p>Street One Lagos</p><a href="https://example.org/">Leave</a>'),$b,$u),false));
 check('render retains authored header and footer without duplicate standard footer',static function()use($b,$u){
  $r=compose_email(['subject'=>'Hello','html'=>'<h2>My custom header</h2><p>{{postal_address}}</p><a href="{{unsubscribe_url}}">Leave</a>'],['email'=>'fixture@example.org','name'=>'Reader'],$b,$u);
  truth(str_contains($r['html'],'My custom header'));truth(!str_contains($r['html'],'data-tz-footer="standard"'));truth(str_contains($r['html'],$u));
 });
}
result();
