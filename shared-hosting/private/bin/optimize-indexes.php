<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/app/Core.php';
use function Sendzad\{one,query};
if(!in_array('--apply',$argv,true)){fwrite(STDERR,"Usage: php optimize-indexes.php --apply\nBack up the database and pause workers first.\n");exit(2);}
$indexes=[['tz_campaigns','campaigns_created','created_at,id'],['tz_campaigns','campaigns_updated','updated_at,id'],['tz_recipients','recipient_accepted','accepted_at']];
foreach($indexes as [$table,$name,$columns]){
 $exists=one('SELECT COUNT(*) n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?',[$table,$name]);
 if((int)$exists['n']===0){query("ALTER TABLE $table ADD INDEX $name ($columns)");echo "Added $name\n";}else echo "Kept $name\n";
}
