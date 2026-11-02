<?php
declare(strict_types=1);
namespace Sendzad;
use PDO;
use RuntimeException;

final class Problem extends RuntimeException {
    public function __construct(string $message, public int $status = 400) { parent::__construct($message); }
}
function config(): array {
    static $config;
    if ($config !== null) return $config;
    $path = dirname(__DIR__) . '/config.php';
    if (!is_file($path)) throw new Problem('Installation required. Add the private configuration file.', 503);
    $config = require $path;
    if (!is_array($config) || strlen((string)base64_decode($config['app_key'] ?? '', true)) !== 32) throw new Problem('A valid installation key is required.', 503);
    $url = parse_url($config['app_url'] ?? '');
    if (!$url || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment']) || (($url['scheme'] ?? '') !== 'https' && !($config['allow_local_http'] ?? false))) throw new Problem('Set a valid HTTPS application URL.',503);
    return $config;
}
function db(): PDO {
    if (isset($GLOBALS['sendzad_test_db'])) return $GLOBALS['sendzad_test_db'];
    static $pdo;
    if (!$pdo) {
        $c = config();
        $pdo = new PDO($c['db_dsn'], $c['db_user'], $c['db_password'], [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES=>false, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    }
    return $pdo;
}
function query(string $sql, array $params = []): \PDOStatement { $q=db()->prepare($sql); $q->execute($params); return $q; }
function one(string $sql,array $params=[]): ?array { return query($sql,$params)->fetch() ?: null; }
function rows(string $sql,array $params=[]): array { return query($sql,$params)->fetchAll(); }
function uid(): string { return bin2hex(random_bytes(16)); }
function esc(string $v): string { return htmlspecialchars($v,ENT_QUOTES|ENT_SUBSTITUTE,'UTF-8'); }
function text(mixed $v,int $max=200,bool $multiline=false): string {
    if (!is_string($v) || strlen($v)>$max || preg_match($multiline?'/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/':'/[\x00-\x1F\x7F]/',$v)) throw new Problem('Check the supplied text.');
    return trim($v);
}
function ident(mixed $v): string { if (!is_string($v)||!preg_match('/^[a-f0-9]{32}$/D',$v)) throw new Problem('Invalid record ID.'); return $v; }
function integer(mixed $v,int $min,int $max): int {
    if (is_bool($v) || (!is_int($v)&&!is_string($v)) || filter_var($v,FILTER_VALIDATE_INT)===false || (int)$v<$min || (int)$v>$max) throw new Problem("Use a number between $min and $max.");
    return (int)$v;
}
function email(mixed $v): ?string {
    if (!is_string($v)) return null;
    $v=trim($v); $at=strrpos($v,'@');
    if (str_contains($v, '"') || str_contains($v, '\\')) return null;
    if ($at===false || strlen($v)>254 || $at>64 || preg_match('/[^\x21-\x7E]/',$v) || !filter_var($v,FILTER_VALIDATE_EMAIL)) return null;
    return substr($v,0,$at).'@'.strtolower(substr($v,$at+1));
}
function seal(string $plain,string $context): string {
    $iv=random_bytes(12); $tag='';
    $cipher=openssl_encrypt($plain,'aes-256-gcm',base64_decode(config()['app_key']),OPENSSL_RAW_DATA,$iv,$tag,$context);
    if ($cipher===false) throw new Problem('Credentials could not be encrypted.',500);
    return base64_encode($iv.$tag.$cipher);
}
function unseal(string $encoded,string $context): string {
    $bytes=base64_decode($encoded,true);
    if ($bytes===false||strlen($bytes)<28) throw new Problem('Stored credentials could not be opened.',503);
    $plain=openssl_decrypt(substr($bytes,28),'aes-256-gcm',base64_decode(config()['app_key']),OPENSSL_RAW_DATA,substr($bytes,0,12),substr($bytes,12,16),$context);
    if ($plain===false) throw new Problem('Stored credentials could not be opened.',503);
    return $plain;
}
function token(string $purpose,string $id): string { return $id.'.'.hash_hmac('sha256',$purpose.':'.$id,base64_decode(config()['app_key'])); }
function read_token(string $purpose,string $value): ?string {
    if (!preg_match('/^([a-f0-9]{32})\.([a-f0-9]{64})$/D',$value,$m)) return null;
    return hash_equals(token($purpose,$m[1]),$value)?$m[1]:null;
}
function setting(string $key,string $default=''): string { return one('SELECT value FROM tz_settings WHERE name=?',[$key])['value']??$default; }
function set_setting(string $key,string $value): void { query('INSERT INTO tz_settings(name,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)',[$key,$value]); }
function audit(string $action,string $id,string $actor='worker'): void { query('INSERT INTO tz_audit(actor,action,object_id,created_at) VALUES(?,?,?,?)',[$actor,$action,$id,time()]); }
function json_response(array $value,int $status=200): never {
    http_response_code($status); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
    echo json_encode($value,JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE); exit;
}
function input(): array {
    if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE']??''),'application/json')) throw new Problem('Use JSON content.',415);
    if ((int)($_SERVER['CONTENT_LENGTH']??0)>1100000) throw new Problem('This request is too large.',413);
    $raw=file_get_contents('php://input',false,null,0,1100001);
    if ($raw===false||strlen($raw)>1100000) throw new Problem('This request is too large.',413);
    try { $data=json_decode($raw,true,32,JSON_THROW_ON_ERROR); } catch (\Throwable) { throw new Problem('Invalid JSON.'); }
    if (!is_array($data)||array_is_list($data)&&$data!==[]) throw new Problem('A JSON object is required.');
    return $data;
}
function session_start_secure(): void {
    if (session_status()===PHP_SESSION_ACTIVE) return;
    $c=config();
    if (!($c['allow_local_http']??false)&&($_SERVER['HTTPS']??'')!=='on') throw new Problem('HTTPS is required. Check your hosting SSL configuration.',403);
    ini_set('session.use_strict_mode','1'); ini_set('session.use_only_cookies','1');
    session_name('sendzad_session');
    session_set_cookie_params(['lifetime'=>0,'path'=>'/','secure'=>!($c['allow_local_http']??false),'httponly'=>true,'samesite'=>'Strict']);
    session_start();
    $_SESSION['csrf']??=bin2hex(random_bytes(32));
}
function require_admin(): int {
    session_start_secure();
    if (empty($_SESSION['admin']) || time()-(int)($_SESSION['last_seen']??0)>3600) { unset($_SESSION['admin']); throw new Problem('Please sign in.',401); }
    $_SESSION['last_seen']=time(); return (int)$_SESSION['admin'];
}
function csrf(): void {
    if (!hash_equals($_SESSION['csrf']??'',$_SERVER['HTTP_X_CSRF_TOKEN']??'')) throw new Problem('Session expired. Refresh and try again.',403);
    $origin=$_SERVER['HTTP_ORIGIN']??'';
    $u=parse_url(config()['app_url']); $expected=$u['scheme'].'://'.$u['host'].(isset($u['port'])?':'.$u['port']:'');
    if ($origin!==''&&!hash_equals($expected,$origin)) throw new Problem('Cross-site requests are not allowed.',403);
}
function login(array $in): array {
    $address=email($in['email']??''); $password=(string)($in['password']??'');
    if (!$address||strlen($password)>1024) throw new Problem('Email or password is incorrect.',401);
    $bucket=hash_hmac('sha256',($_SERVER['REMOTE_ADDR']??'unknown'),base64_decode(config()['app_key']));
    query('INSERT IGNORE INTO tz_login_attempts(bucket,attempts,reset_at) VALUES(?,0,?)',[$bucket,time()+900]);
    query('UPDATE tz_login_attempts SET attempts=0,reset_at=? WHERE bucket=? AND reset_at<?',[time()+900,$bucket,time()]);
    query('UPDATE tz_login_attempts SET attempts=attempts+1 WHERE bucket=?',[$bucket]);
    if ((int)one('SELECT attempts FROM tz_login_attempts WHERE bucket=?',[$bucket])['attempts']>10) throw new Problem('Too many attempts. Try again in 15 minutes.',429);
    $user=one('SELECT * FROM tz_admins WHERE email=?',[$address]);
    $dummy='$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';
    $valid=password_verify($password,$user['password_hash']??$dummy);
    if (!$user||!$valid) throw new Problem('Email or password is incorrect.',401);
    session_regenerate_id(true); $_SESSION['admin']=(int)$user['id']; $_SESSION['last_seen']=time(); $_SESSION['csrf']=bin2hex(random_bytes(32));
    query('DELETE FROM tz_login_attempts WHERE bucket=?',[$bucket]);
    audit('sign_in',(string)$user['id'],(string)$user['id']); return ['ok'=>true,'csrf'=>$_SESSION['csrf']];
}
function account_config(array $row): array { return json_decode(unseal($row['config_cipher'],'account:'.$row['id']),true,32,JSON_THROW_ON_ERROR); }
function public_account(array $row): array {
    $c=account_config($row);
    unset($c['password'],$c['api_key']); unset($row['config_cipher']);
    $row['config']=$c; return $row;
}
function fetch_json(string $url,?array $body=null,array $headers=[]): array {
    if (!extension_loaded('curl')) throw new Problem('Enable the PHP cURL extension.',503);
    if (parse_url($url,PHP_URL_SCHEME)!=='https') throw new Problem('HTTPS is required.',400);
    $ch=curl_init($url); $buffer='';
    curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>false,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_CONNECTTIMEOUT=>8,CURLOPT_TIMEOUT=>20,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,CURLOPT_HTTPHEADER=>array_merge(['Accept: application/json'],$body!==null?['Content-Type: application/json']:[],$headers),CURLOPT_WRITEFUNCTION=>static function($ch,$chunk)use(&$buffer){ if(strlen($buffer)+strlen($chunk)>4000000)return 0; $buffer.=$chunk; return strlen($chunk); }]);
    // libcurl retains its configured HTTP(S)_PROXY / NO_PROXY environment.
    if ($body!==null) { curl_setopt($ch,CURLOPT_POST,true); curl_setopt($ch,CURLOPT_POSTFIELDS,json_encode($body,JSON_THROW_ON_ERROR)); }
    $ok=curl_exec($ch); $status=(int)curl_getinfo($ch,CURLINFO_RESPONSE_CODE); curl_close($ch);
    if ($ok===false) throw new Problem('The provider response was not confirmed. Check provider history before repeating this action.',502);
    if ($status<200||$status>=300) throw new Problem($status===429?'Provider rate limit reached. Processing is paused.':'Provider request was not accepted (HTTP '.$status.').',502);
    try{$data=json_decode($buffer,true,64,JSON_THROW_ON_ERROR);}catch(\Throwable){throw new Problem('The provider returned an invalid response.',502);}
    if(!is_array($data))throw new Problem('The provider returned an invalid response.',502);
    return ['status'=>$status,'data'=>$data];
}
function csv_cell(mixed $v): string { $s=(string)($v??''); return preg_match('/^\s*[=+@\-\t\r]/',$s)?"'".$s:$s; }
