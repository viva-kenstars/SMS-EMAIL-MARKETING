<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
$connect=in_array('--connect',$argv,true);
if(count(array_diff(array_slice($argv,1),['--connect']))){fwrite(STDERR,"Usage: php verifier-doctor.php [--connect]\n");exit(2);}
$root=dirname(__DIR__);$report=['checks'=>[],'mailbox_acceptance_tested'=>false,'paid_fallback'=>false,'mutations'=>false];$ok=true;
try{
    require_once $root.'/app/Core.php';require_once $root.'/app/SelfVerifier.php';
    $setup=Sendzad\verifier_setup_status(Sendzad\config());$report['connection']=$setup;$ok=$setup['configured'];
    foreach(['curl','pdo_mysql','openssl']as $extension){$has=extension_loaded($extension);$report['checks'][$extension]=$has?'available':'missing';$ok=$ok&&$has;}
    try{
        // SELECT-only schema probes: never import/reset a database or start a job.
        Sendzad\query('SELECT job_id,config_hash FROM tz_self_verification_jobs LIMIT 0');
        Sendzad\query('SELECT item_id,attempts,deferrals,next_at,reason,evidence FROM tz_self_verification_results LIMIT 0');
        $report['checks']['migration_0003']='present';
    }catch(Throwable){$report['checks']['migration_0003']='not confirmed: check database access and apply 0003_self_verifier.sql';$ok=false;}
    $report['checks']['service']='not tested; use --connect for an authenticated health read';
    if($connect&&$setup['configured']){
        try{$report['health']=Sendzad\self_health();$report['checks']['service']='responded';}
        catch(Sendzad\Problem $e){$report['checks']['service']=$e->getMessage();$ok=false;}
    }
}catch(Throwable){$report['checks']['installation']='private configuration or required modules unavailable';$ok=false;}
$report['ok']=$ok;echo json_encode($report,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES)."\n";exit($ok?0:1);
