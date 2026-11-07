<?php
declare(strict_types=1);
namespace Sendzad;

/** Bounded drain of already-started verification only. Never invokes a sending worker.
 * Reserve time for each additional HTTP call. The first call has its own timeout;
 * this work budget is not an OS-enforced wall-clock deadline.
 */
function drain_verification(callable $advance, int $seconds=40, int $maxSteps=10, ?callable $clock=null, ?callable $sleep=null): array {
    $clock??=static fn()=>(float)hrtime(true)/1e9;
    $sleep??=static function(int $n):void{sleep($n);};
    $seconds=max(5,min(45,$seconds));$maxSteps=max(1,min(20,$maxSteps));
    $deadline=$clock()+$seconds;$steps=0;$advanced=0;
    while($steps<$maxSteps&&$clock()<$deadline){
        // Do not begin another up-to-25-second verifier request without budget.
        if($steps>0&&$clock()+25>$deadline)break;
        $r=$advance();$steps++;$advanced+=(int)($r['advanced']??0);
        if(!empty($r['attention']))return ['steps'=>$steps,'advanced'=>$advanced,'attention'=>$r['attention']];
        if(!empty($r['busy'])||($r['engine']??'')!=='sendzad')break;
        // Keep legacy paid-provider processing at one step per invocation.
        $next=$r['next_at']??null;
        if($next!==null){
            $wait=max(0,(int)$next-time());
            if($wait>0){if($clock()+$wait+25>$deadline)break;$sleep($wait);}
        }elseif(empty($r['advanced']))break;
    }
    return ['steps'=>$steps,'advanced'=>$advanced];
}
