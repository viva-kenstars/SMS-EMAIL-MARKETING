<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli')exit;
if(!extension_loaded('pdo_mysql')||!class_exists('DOMDocument')){fwrite(STDERR,"NOT RUN: integration tests require pdo_mysql, DOM and a disposable MySQL database.\n");exit(2);}
if(getenv('SENDZAD_TEST_RESET')!=='1'){fwrite(STDERR,"Set SENDZAD_TEST_RESET=1 to authorize resetting ONLY the configured _test database.\n");exit(2);}
require __DIR__.'/bootstrap.php';
use function Sendzad\{db,query,one,rows,uid,seal,unseal,setting,set_setting,save_account,public_account,save_campaign,launch_campaign,control_campaign,advance_campaign,with_worker_lock,record_event,metrics,process_sendgrid,import_contacts,create_verification,control_verification,advance_verification,add_verified_to_group,api_route};
$pdo=new PDO($testConfig['db_dsn'],$testConfig['db_user'],$testConfig['db_password'],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_EMULATE_PREPARES=>false,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
$name=$pdo->query('SELECT DATABASE()')->fetchColumn();if(!str_ends_with($name,'_test'))throw new RuntimeException('Refusing to reset a non-test database.');
$GLOBALS['sendzad_test_db']=$pdo;
$pdo->exec('SET FOREIGN_KEY_CHECKS=0');foreach($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN)as $table){if(str_starts_with($table,'tz_'))$pdo->exec('DROP TABLE `'.$table.'`');}$pdo->exec('SET FOREIGN_KEY_CHECKS=1');
$pdo->exec(file_get_contents(dirname(__DIR__).'/database/schema.sql'));
function groupFixture(string $name='Synthetic group'):string{$id=Sendzad\uid();Sendzad\query('INSERT INTO tz_groups(id,name,created_at) VALUES(?,?,?)',[$id,$name,time()]);return $id;}
function accountFixture():array{$a=Sendzad\save_account(['label'=>'Synthetic SMTP','provider'=>'smtp','config'=>['host'=>'smtp.example.net','port'=>587,'security'=>'starttls','username'=>'fixture','password'=>'never-sent-on-network','from_email'=>'sender@example.net','from_name'=>'Fixture']]);Sendzad\query('UPDATE tz_accounts SET verified_at=?,enabled=1 WHERE id=?',[time(),$a['id']]);return Sendzad\one('SELECT * FROM tz_accounts WHERE id=?',[$a['id']]);}
function draftFixture():array{return Sendzad\save_campaign(['name'=>'Synthetic campaign','subject'=>'Hello {{first_name}}','html'=>'<p>Hi {{name}}</p>','text_body'=>'Hi {{name}}','track_opens'=>true,'track_clicks'=>true]);}
function dueFixture(string $id):void{Sendzad\query('UPDATE tz_campaigns SET due_at=0 WHERE id=?',[$id]);Sendzad\query('UPDATE tz_accounts SET next_at=0');}
$gid=groupFixture();$aid=null;$cid=null;
// Campaign tests use a real-shaped synthetic business identity, not a platform default.
set_setting('email_brand',json_encode(['name'=>'Fixture business','website'=>'https://sendzad.com']));
check('schema imports into real MySQL',static fn()=>truth(count(rows('SHOW TABLES'))>=14));
check('chunk import rejects invalid emails and deduplicates membership',static function()use($gid){$r=import_contacts(['group_id'=>$gid,'consent'=>true,'rows'=>[['email'=>'one@example.net'],['email'=>'one@example.net'],['email'=>'two@example.net'],['email'=>'bad']]]);eq($r['added'],2);eq((int)one('SELECT COUNT(*) n FROM tz_members')['n'],2);});
check('reimport cannot clear suppression or upgrade consent',static function()use($gid){query("UPDATE tz_contacts SET suppressed=1,consent=0 WHERE email='one@example.net'");import_contacts(['group_id'=>$gid,'consent'=>true,'rows'=>[['email'=>'one@example.net']]]);$c=one("SELECT * FROM tz_contacts WHERE email='one@example.net'");eq((int)$c['suppressed'],1);eq((int)$c['consent'],0);});
check('account passwords are encrypted and absent from responses',static function()use(&$aid){$a=accountFixture();$aid=$a['id'];truth(!str_contains($a['config_cipher'],'never-sent'));$p=public_account($a);truth(!isset($p['config']['password']));truth(!isset($p['config_cipher']));});
check('verification jobs are created but never implicitly started',static function()use($gid){$j=create_verification(['name'=>'Ready fixture','group_id'=>$gid]);$calls=0;advance_verification(static function()use(&$calls){$calls++;throw new RuntimeException('No network');});eq($calls,0);eq(one('SELECT status FROM tz_verification_jobs WHERE id=?',[$j['id']])['status'],'ready');});
check('launch requires explicit audience permission',static function()use($gid,&$aid){$c=draftFixture();rejects(static fn()=>launch_campaign(['id'=>$c['id'],'revision'=>$c['revision'],'group_ids'=>[$gid],'account_ids'=>[$aid]]),400);});
check('new imports cannot qualify as verified solely through syntax',static function()use($gid,&$aid){set_setting('postal_address','Test business, Lagos');$c=draftFixture();rejects(static fn()=>launch_campaign(['id'=>$c['id'],'revision'=>$c['revision'],'group_ids'=>[$gid],'account_ids'=>[$aid],'consent_confirmed'=>true]),400);eq((int)one('SELECT COUNT(*) n FROM tz_recipients WHERE campaign_id=?',[$c['id']])['n'],0);});
check('launch freezes only verified opted-in unsuppressed recipients',static function()use($gid,&$aid,&$cid){query("UPDATE tz_contacts SET verification='valid' WHERE email='two@example.net'");$c=draftFixture();$cid=$c['id'];$r=launch_campaign(['id'=>$cid,'revision'=>$c['revision'],'group_ids'=>[$gid,$gid],'account_ids'=>[$aid],'consent_confirmed'=>true,'interval_seconds'=>2]);eq($r['recipients'],1);});
check('started campaign content is immutable',static function()use(&$cid){$c=one('SELECT * FROM tz_campaigns WHERE id=?',[$cid]);$c['subject']='Changed';rejects(static fn()=>save_campaign($c),409);});
check('no recipient sends twice after acceptance',static function()use(&$cid){$calls=0;$transport=static function($a,$c,$r)use(&$calls){$calls++;return ['status'=>'accepted','message_id'=>'<fixture@example.net>','error'=>null];};advance_campaign($transport);dueFixture($cid);advance_campaign($transport);dueFixture($cid);advance_campaign($transport);eq($calls,1);eq(metrics($cid)['accepted'],1);eq(one('SELECT status FROM tz_campaigns WHERE id=?',[$cid])['status'],'completed');});
$rid=one('SELECT id FROM tz_recipients WHERE campaign_id=?',[$cid])['id'];
check('SMTP acceptance never invents delivery',static fn()=>eq(metrics($cid)['delivered'],0));
check('event replay is idempotent',static function()use($rid,$cid){truth(record_event($rid,'delivered','fixture','event1',time()));eq(record_event($rid,'delivered','fixture','event1',time()),false);eq(metrics($cid)['delivered'],1);});
check('machine opens stay separate from ordinary estimated opens',static function()use($rid,$cid){record_event($rid,'open','fixture','machine1',time(),true);eq(metrics($cid)['machine_opens'],1);eq(metrics($cid)['opened'],0);record_event($rid,'open','fixture','normal1',time());eq(metrics($cid)['opened'],1);});
check('unsubscribe persists suppression across every sender',static function()use($rid){record_event($rid,'unsubscribe','fixture','unsubscribe1',time());eq((int)one("SELECT suppressed FROM tz_contacts WHERE email='two@example.net'")['suppressed'],1);});
check('tracking events respect campaign privacy options',static function()use($rid,$cid){query('UPDATE tz_campaigns SET track_clicks=0 WHERE id=?',[$cid]);eq(record_event($rid,'click','fixture','click-privacy',time()),false);eq(metrics($cid)['clicked'],0);});
check('full overview and table queries run under native SQL',static function(){$_GET=['days'=>'30'];truth(isset(api_route('overview','GET',[])['metrics']));$_GET=[];foreach(['campaigns','contacts','jobs','groups','accounts','settings']as $r)truth(is_array(api_route($r,'GET',[])));});
check('unknown submission is never automatically replayed',static function()use(&$aid){$g=groupFixture('Unknown fixture');import_contacts(['group_id'=>$g,'consent'=>true,'rows'=>[['email'=>'unknown@example.net']]]);query("UPDATE tz_contacts SET verification='valid' WHERE email='unknown@example.net'");$c=draftFixture();launch_campaign(['id'=>$c['id'],'revision'=>$c['revision'],'group_ids'=>[$g],'account_ids'=>[$aid],'consent_confirmed'=>true]);dueFixture($c['id']);$calls=0;$t=static function()use(&$calls){$calls++;return ['status'=>'unknown','message_id'=>null,'error'=>'Synthetic lost acknowledgement'];};advance_campaign($t);dueFixture($c['id']);advance_campaign($t);eq($calls,1);eq(one('SELECT status FROM tz_campaigns WHERE id=?',[$c['id']])['status'],'needs_attention');});
check('paused campaigns are not advanced',static function()use(&$aid){$g=groupFixture('Pause fixture');import_contacts(['group_id'=>$g,'consent'=>true,'rows'=>[['email'=>'pause@example.net']]]);query("UPDATE tz_contacts SET verification='valid' WHERE email='pause@example.net'");$c=draftFixture();launch_campaign(['id'=>$c['id'],'revision'=>$c['revision'],'group_ids'=>[$g],'account_ids'=>[$aid],'consent_confirmed'=>true]);control_campaign(['id'=>$c['id'],'action'=>'pause']);$calls=0;advance_campaign(static function()use(&$calls){$calls++;});eq($calls,0);});
check('verification uses saved results and adds valid contacts once',static function(){
 $g=groupFixture('Verification fixture');import_contacts(['group_id'=>$g,'consent'=>true,'rows'=>[['email'=>'verify@example.net']]]);$j=create_verification(['name'=>'Verifier fixture','group_id'=>$g]);set_setting('reoon_key',seal('synthetic-provider-key','reoon'));control_verification(['id'=>$j['id'],'action'=>'start','provider_consent'=>true]);$calls=0;
 advance_verification(static function($url,$body=null)use(&$calls){$calls++;truth(str_contains($url,'mode=power'));return ['status'=>200,'data'=>['email'=>'verify@example.net','status'=>'safe','verification_mode'=>'power','is_safe_to_send'=>true,'is_deliverable'=>true,'is_disposable'=>false,'is_role_account'=>false,'has_inbox_full'=>false,'is_catch_all'=>false,'is_disabled'=>false,'is_spamtrap'=>false]];});eq($calls,1);eq(one('SELECT status FROM tz_verification_jobs WHERE id=?',[$j['id']])['status'],'completed');$target=groupFixture('Verified results');eq(add_verified_to_group(['job_id'=>$j['id'],'group_id'=>$target])['added'],1);eq(add_verified_to_group(['job_id'=>$j['id'],'group_id'=>$target])['added'],0);
});
check('interrupted verification submission is held, not repurchased',static function(){
 $g=groupFixture('Uncertain verification');import_contacts(['group_id'=>$g,'consent'=>true,'rows'=>[['email'=>'uncertain@example.net']]]);$j=create_verification(['name'=>'Uncertain fixture','group_id'=>$g]);control_verification(['id'=>$j['id'],'action'=>'start','provider_consent'=>true]);$calls=0;$t=static function()use(&$calls){$calls++;throw new RuntimeException('Synthetic transport timeout');};advance_verification($t);advance_verification($t);eq($calls,1);eq(one('SELECT status FROM tz_verification_jobs WHERE id=?',[$j['id']])['status'],'needs_attention');
});

check('brand settings save atomically and reject invalid links before mutation',static function(){
 $saved=api_route('settings','POST',['brand'=>['name'=>'Studio One','website'=>'https://sendzad.com'],'postal_address'=>'Studio One, Lagos']);eq($saved['brand']['name'],'Studio One');
 rejects(static fn()=>api_route('settings','POST',['brand'=>['name'=>'Bad save','website'=>'javascript:bad()'],'postal_address'=>'Changed']));eq(Sendzad\brand_config()['name'],'Studio One');eq(setting('postal_address'),'Studio One, Lagos');
 rejects(static fn()=>api_route('settings','POST',['brand'=>['name'=>'Invalid address save'],'postal_address'=>[1,2]]));eq(Sendzad\brand_config()['name'],'Studio One');
});
check('placeholder campaign launch rolls back before audience or account use',static function()use(&$aid){
 $g=groupFixture('Template preflight');import_contacts(['group_id'=>$g,'consent'=>true,'rows'=>[['email'=>'template-fixture@example.net']]]);query("UPDATE tz_contacts SET verification='valid' WHERE email='template-fixture@example.net'");
 $t=Sendzad\email_catalog()['templates'][2];$c=save_campaign(['name'=>'Placeholder campaign','subject'=>$t['subject'],'html'=>$t['html'],'preheader'=>$t['preheader']]);
 rejects(static fn()=>launch_campaign(['id'=>$c['id'],'revision'=>$c['revision'],'group_ids'=>[$g],'account_ids'=>[$aid],'consent_confirmed'=>true]),409);
 eq((int)one('SELECT COUNT(*) n FROM tz_recipients WHERE campaign_id=?',[$c['id']])['n'],0);eq((int)one('SELECT COUNT(*) n FROM tz_campaign_accounts WHERE campaign_id=?',[$c['id']])['n'],0);eq(setting('campaign_brand_'.$c['id']),'');
});
check('unfinished test campaign creates no send intent or quota charge',static function()use(&$aid){
 $c=save_campaign(['name'=>'Unfinished test','subject'=>'[Replace me]','html'=>'<p>[Sample copy]</p>']);$before=one('SELECT used_today FROM tz_accounts WHERE id=?',[$aid])['used_today'];
 rejects(static fn()=>Sendzad\test_campaign(['id'=>$c['id'],'account_id'=>$aid,'request_id'=>uid(),'email'=>'template-test@example.net']),409);
 eq(one('SELECT used_today FROM tz_accounts WHERE id=?',[$aid])['used_today'],$before);eq((int)one('SELECT COUNT(*) n FROM tz_recipients WHERE campaign_id=?',[$c['id']])['n'],0);
});
check('launch freezes branding while later drafts use updated settings',static function()use(&$aid){
 $g=groupFixture('Frozen branding');import_contacts(['group_id'=>$g,'consent'=>true,'rows'=>[['email'=>'frozen-brand@example.net']]]);query("UPDATE tz_contacts SET verification='valid' WHERE email='frozen-brand@example.net'");
 $t=Sendzad\email_catalog()['templates'][0];$c=save_campaign(['name'=>'Frozen brand fixture','subject'=>$t['subject'],'html'=>$t['html'],'preheader'=>$t['preheader'],'text_body'=>Sendzad\email_plaintext($t['html'])]);
 launch_campaign(['id'=>$c['id'],'revision'=>$c['revision'],'group_ids'=>[$g],'account_ids'=>[$aid],'consent_confirmed'=>true]);
 api_route('settings','POST',['brand'=>['name'=>'Studio Two','website'=>'https://sendzad.com'],'postal_address'=>'Studio Two, Abuja']);
 eq(Sendzad\brand_for_campaign($c)['name'],'Studio One');eq(Sendzad\brand_for_campaign($c)['postal_address'],'Studio One, Lagos');eq(Sendzad\brand_config()['name'],'Studio Two');
 $r=one('SELECT * FROM tz_recipients WHERE campaign_id=?',[$c['id']]);$m=Sendzad\render_mail($c,$r);truth(str_contains($m['html'],'Studio One'));truth(!str_contains($m['html'],'Studio Two'));eq(substr_count($m['html'],'data-tz-footer="standard"'),1);
 control_campaign(['id'=>$c['id'],'action'=>'pause']);
});

result();
