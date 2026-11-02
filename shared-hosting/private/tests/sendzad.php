<?php
declare(strict_types=1);
require __DIR__.'/bootstrap.php';
use function Sendzad\{event_delivery_id,brand_defaults,email_layout,email_catalog,import_contacts};
$id=str_repeat('a',32);
check('new callback identifier is supported',static fn()=>eq(event_delivery_id(['sendzad_delivery_id'=>$id]),$id));
check('legacy callback identifier is supported',static fn()=>eq(event_delivery_id(['trezad_delivery_id'=>$id]),$id));
check('matching dual identifiers are supported',static fn()=>eq(event_delivery_id(['sendzad_delivery_id'=>$id,'trezad_delivery_id'=>$id]),$id));
check('conflicting identifiers are rejected',static fn()=>eq(event_delivery_id(['sendzad_delivery_id'=>$id,'trezad_delivery_id'=>str_repeat('b',32)]),null));
check('malformed identifier is rejected',static fn()=>eq(event_delivery_id(['sendzad_delivery_id'=>['bad']]),null));
check('default email brand is not forced to the platform',static fn()=>eq(brand_defaults()['name'],''));
check('layout metadata excludes the full library',static function(){truth(!isset(email_layout()['templates']));truth(strlen(json_encode(email_layout()))<4000);});
check('all designs contain an HTTPS photograph with alt text',static function(){foreach(email_catalog()['templates'] as $t){truth(str_contains($t['html'],'https://images.unsplash.com/photo-'));truth(str_contains($t['html'],'data-sz-image="stock"'));truth(!str_contains($t['html'],'IMAGE PLACEHOLDER'));truth(!str_contains(strtolower($t['html']),'trezad'));truth(!str_contains(strtolower($t['html']),'sendzad'));}});
check('all generated personalization tokens are recognized',static function(){
 $known=['email','name','first_name','brand_name','website_url','postal_address','permission_reminder','year','preheader','unsubscribe_url'];
 foreach(email_catalog()['templates'] as $t){preg_match_all('/\{\{([^}]+)\}\}/',$t['html'].$t['subject'].$t['preheader'],$m);foreach($m[1] as $key)truth(in_array($key,$known,true));}
});
// SQL-shape fixtures, not a substitute for the real MySQL integration suite.
final class ImportFixture extends PDO {
 public array $calls=[];public bool $active=false;public bool $rolledBack=false;public int $existing=0;public bool $failMembers=false;
 public function __construct(){}
 public function prepare(string $query,array $options=[]):PDOStatement|false{return new ImportStatement($this,$query);}
 public function beginTransaction():bool{$this->active=true;return true;}
 public function commit():bool{$this->active=false;return true;}
 public function rollBack():bool{$this->active=false;$this->rolledBack=true;return true;}
 public function inTransaction():bool{return $this->active;}
}
final class ImportStatement extends PDOStatement {
 private array $values=[];
 public function __construct(private ImportFixture $db,private string $sql){}
 public function execute(?array $params=null):bool{$this->values=$params??[];$this->db->calls[]=[$this->sql,$this->values];if($this->db->failMembers&&str_starts_with($this->sql,'INSERT IGNORE INTO tz_members'))throw new RuntimeException('fixture membership failure');return true;}
 public function fetch(int $mode=PDO::FETCH_DEFAULT,int $cursorOrientation=PDO::FETCH_ORI_NEXT,int $cursorOffset=0):mixed{return ['id'=>str_repeat('a',32)];}
 public function rowCount():int{return str_starts_with($this->sql,'INSERT IGNORE INTO tz_contacts')?intdiv(count($this->values),4)-$this->db->existing:0;}
}
check('500 contacts use three SQL operations, not per-address queries',static function(){
 $db=new ImportFixture();$GLOBALS['sendzad_test_db']=$db;
 $list=[];for($i=0;$i<500;$i++)$list[]=['email'=>"person$i@example.net",'name'=>"Person $i"];
 $r=import_contacts(['group_id'=>str_repeat('a',32),'rows'=>$list,'consent'=>true]);
 eq($r,['added'=>500,'invalid'=>0,'duplicates'=>0]);eq(count($db->calls),3);eq(count($db->calls[1][1]),2000);eq(count($db->calls[2][1]),501);truth(!$db->active);
});
check('duplicates and invalid records retain exact counts',static function(){
 $db=new ImportFixture();$db->existing=1;$GLOBALS['sendzad_test_db']=$db;
 $r=import_contacts(['group_id'=>str_repeat('a',32),'rows'=>[['email'=>'Ada@EXAMPLE.NET'],['email'=>'Ada@example.net'],['email'=>'new@example.net'],['email'=>'bad']]]);
 eq($r,['added'=>1,'invalid'=>1,'duplicates'=>2]);eq(count($db->calls),3);
});
check('bulk importer never overwrites existing consent or suppression',static function(){
 $db=new ImportFixture();$GLOBALS['sendzad_test_db']=$db;
 import_contacts(['group_id'=>str_repeat('a',32),'rows'=>[['email'=>'a@example.net']],'consent'=>true]);
 foreach($db->calls as [$sql]){truth(!str_contains($sql,'UPDATE'));truth(!str_contains($sql,'REPLACE'));}
});
check('membership failure rolls back the whole import chunk',static function(){
 $db=new ImportFixture();$db->failMembers=true;$GLOBALS['sendzad_test_db']=$db;
 rejects(static fn()=>import_contacts(['group_id'=>str_repeat('a',32),'rows'=>[['email'=>'a@example.net']]]));truth($db->rolledBack);truth(!$db->active);
});
check('oversized chunk never starts a transaction',static function(){
 $db=new ImportFixture();$GLOBALS['sendzad_test_db']=$db;
 rejects(static fn()=>import_contacts(['group_id'=>str_repeat('a',32),'rows'=>array_fill(0,501,['email'=>'a@example.net'])]));eq(count($db->calls),1);truth(!$db->active);
});
unset($GLOBALS['sendzad_test_db']);
result();
