<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
$root=dirname(__DIR__);if(is_file($root.'/vendor/autoload.php'))require $root.'/vendor/autoload.php';
foreach(['Core','Templates','Content','Mailer','Campaigns','Reports','Verification']as $module)require $root.'/app/'.$module.'.php';
$mode=$argv[1]??'';
if(!in_array($mode,['verify','send'],true)){fwrite(STDERR,"Usage: php worker.php verify|send\n");exit(1);}
try{
    $c=Sendzad\config();$seconds=min(45,max(5,(int)($c['worker_seconds']??40)));$max=min(50,max(1,(int)($c['worker_messages']??20)));$start=microtime(true);$count=0;
    set_time_limit($seconds+30);
    if($mode==='verify'){
        require_once $root.'/app/VerifierWorker.php';
        $r=Sendzad\drain_verification(static fn()=>Sendzad\advance_verification(),$seconds,(int)($c['verification_max_steps']??10));
        if(!empty($r['attention'])){fwrite(STDERR,$r['attention']."\n");exit(1);}
        exit(0);
    }
    while(microtime(true)-$start<$seconds && $count<$max){
        $r=$mode==='verify'?Sendzad\advance_verification():Sendzad\advance_campaign();
        if(!empty($r['attention'])){fwrite(STDERR,$r['attention']."\n");break;}
        if(!empty($r['busy']))break;
        if(empty($r['advanced'])){
            $wait=isset($r['next_at'])?max(1,(int)$r['next_at']-time()):null;
            if($mode!=='send'||$wait===null||microtime(true)-$start+$wait+2>=$seconds)break;
            sleep(min($wait,5));continue;
        }
        $count++;if($mode==='verify')break;
        // No browser dependency. Respect due times rather than rapid retries.
        sleep(1);
    }
    exit(0);
}catch(Throwable $e){fwrite(STDERR,$e instanceof Sendzad\Problem?$e->getMessage()."\n":"Worker stopped. Check installation and saved progress.\n");exit(1);}
