<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli')exit;
if(!extension_loaded('pdo_mysql')||!class_exists('DOMDocument')){fwrite(STDERR,"NOT RUN: requires PHP DOM, PDO MySQL and a disposable _test database.\n");exit(2);}
if(getenv('SENDZAD_TEST_RESET')!=='1'){fwrite(STDERR,"Set SENDZAD_TEST_RESET=1 to authorize resetting only the configured _test database.\n");exit(2);}
require __DIR__.'/bootstrap.php';
require dirname(__DIR__).'/app/SavedTemplates.php';
use function Sendzad\{db,one,rows,query,saved_template_save,saved_template_get,saved_template_route};
$pdo=new PDO($testConfig['db_dsn'],$testConfig['db_user'],$testConfig['db_password'],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_EMULATE_PREPARES=>false,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
if(!str_ends_with((string)$pdo->query('SELECT DATABASE()')->fetchColumn(),'_test'))throw new RuntimeException('Refusing non-test database.');
$GLOBALS['sendzad_test_db']=$pdo;
$pdo->exec('SET FOREIGN_KEY_CHECKS=0');foreach($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN)as $table)if(str_starts_with($table,'tz_'))$pdo->exec('DROP TABLE `'.$table.'`');$pdo->exec('SET FOREIGN_KEY_CHECKS=1');
$pdo->exec(file_get_contents(dirname(__DIR__).'/database/schema.sql'));
$migration=file_get_contents(dirname(__DIR__).'/database/migrations/0002_saved_templates.sql');$pdo->exec($migration);$pdo->exec($migration);
$fixture=['name'=>'Reusable fixture','category'=>'News','subject'=>'An update','preheader'=>'Preview','html'=>'<h1>Editable</h1><p>Body</p>','text_body'=>'Body'];$t=null;$campaign=null;
check('create and reload independent template',static function()use(&$t,$fixture){$t=saved_template_save($fixture);eq((int)$t['revision'],1);eq(saved_template_get($t['id'])['name'],$fixture['name']);eq((int)one('SELECT COUNT(*) n FROM tz_campaigns')['n'],0);});
check('save increments revision and keeps history',static function()use(&$t){$t=saved_template_save([...$t,'name'=>'Updated name']);eq((int)$t['revision'],2);eq((int)one('SELECT COUNT(*) n FROM tz_template_versions')['n'],2);});
check('stale save rejected without overwriting',static function()use(&$t){rejects(static fn()=>saved_template_save([...$t,'revision'=>1,'name'=>'Stale']),409);eq(saved_template_get($t['id'])['name'],'Updated name');});
check('create campaign copies saved content without audience or sending',static function()use(&$t,&$campaign){$campaign=saved_template_route('use','POST',['id'=>$t['id'],'revision'=>(int)$t['revision']])['campaign'];eq($campaign['status'],'draft');eq($campaign['subject'],'An update');eq((int)one('SELECT COUNT(*) n FROM tz_recipients')['n'],0);eq((int)one('SELECT COUNT(*) n FROM tz_campaign_accounts')['n'],0);});
check('template edits cannot mutate an existing campaign copy',static function()use(&$t,&$campaign){$t=saved_template_save([...$t,'subject'=>'New template subject']);eq(one('SELECT subject FROM tz_campaigns WHERE id=?',[$campaign['id']])['subject'],'An update');});
check('duplicate receives independent ID',static function()use(&$t){$d=saved_template_route('duplicate','POST',['id'=>$t['id']])['template'];truth($d['id']!==$t['id']);truth(str_ends_with($d['name'],'(copy)'));});
check('archive stops template use and can be undone',static function()use(&$t){saved_template_route('archive','POST',['id'=>$t['id'],'revision'=>(int)$t['revision'],'archived'=>true]);$t=saved_template_get($t['id']);rejects(static fn()=>saved_template_route('use','POST',['id'=>$t['id'],'revision'=>(int)$t['revision']]),409);saved_template_route('archive','POST',['id'=>$t['id'],'revision'=>(int)$t['revision'],'archived'=>false]);$t=saved_template_get($t['id']);eq((int)$t['archived'],0);});
check('restore writes a new revision rather than erasing history',static function()use(&$t){$rev=(int)$t['revision'];$t=saved_template_route('restore','POST',['id'=>$t['id'],'revision'=>$rev,'version'=>1])['template'];eq((int)$t['revision'],$rev+1);eq($t['name'],'Reusable fixture');});
check('history retention is bounded',static function()use(&$t){for($i=0;$i<25;$i++)$t=saved_template_save([...$t,'name'=>'Revision '.$i]);eq((int)one('SELECT COUNT(*) n FROM tz_template_versions WHERE template_id=?',[$t['id']])['n'],20);});
check('list returns metadata, not full HTML bodies',static function(){$_GET=[];$r=saved_template_route('list','GET',[]);truth(count($r['items'])>0);truth(!array_key_exists('html',$r['items'][0]));});
result();
