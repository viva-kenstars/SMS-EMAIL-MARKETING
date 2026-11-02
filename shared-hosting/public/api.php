<?php
declare(strict_types=1);
require __DIR__.'/_bootstrap.php';
use function Sendzad\{session_start_secure,require_admin,csrf,input,json_response,api_route,login,export_report};
use Sendzad\Problem;
try{
    $route=(string)($_GET['r']??'session');$method=$_SERVER['REQUEST_METHOD']??'GET';
    if(!in_array($method,['GET','POST'],true))throw new Problem('Method not allowed.',405);
    session_start_secure();
    if($route==='session')json_response(['authenticated'=>!empty($_SESSION['admin'])&&time()-(int)($_SESSION['last_seen']??0)<3600,'csrf'=>$_SESSION['csrf']]);
    $writes=['login','logout','campaign/launch','campaign/control','campaign/test','campaign/duplicate','contacts/import','contacts/suppress','jobs/control','jobs/add-valid','accounts/test','accounts/toggle'];
    if(in_array($route,$writes,true)&&$method!=='POST')throw new Problem('Use POST for this action.',405);
    $in=[];if($method==='POST'){csrf();$in=input();}
    if($route==='login')json_response(login($in));
    require_admin();
    if($route==='logout'){$_SESSION=[];session_destroy();json_response(['ok'=>true]);}
    session_write_close();
    if($route==='export')export_report((string)($_GET['id']??''));
    $out=api_route($route,$method,$in);
    if(!empty($out['busy']))throw new Problem('Another sending operation is in progress. Try again shortly.',409);
    json_response($out);
}catch(Problem $e){json_response(['error'=>$e->getMessage()],$e->status);}
catch(Throwable){json_response(['error'=>'The request could not finish. Check server setup and saved records before repeating a send.'],500);}
