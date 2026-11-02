<?php
declare(strict_types=1);
require __DIR__.'/_bootstrap.php';
require_once $appRoot.'/app/SavedTemplates.php';
use function Sendzad\{require_admin,csrf,input,json_response,saved_template_route};
use Sendzad\Problem;
try{
    $method=$_SERVER['REQUEST_METHOD']??'GET';
    if(!in_array($method,['GET','POST'],true))throw new Problem('Use GET or POST.',405);
    require_admin();$in=[];
    if($method==='POST'){csrf();$in=input();}
    session_write_close();
    json_response(saved_template_route((string)($_GET['r']??'list'),$method,$in));
}catch(Problem $e){json_response(['error'=>$e->getMessage()],$e->status);}
catch(Throwable){json_response(['error'=>'Template storage is unavailable. Check the saved-template migration and PHP DOM extension.'],503);}
