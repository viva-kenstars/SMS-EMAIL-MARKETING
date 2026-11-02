<?php
declare(strict_types=1);
namespace Sendzad;
function safe_url(string $value,bool $image=false): bool {
    $url=parse_url($value);
    if($url===false)return false;
    $scheme=strtolower($url['scheme']??'');
    if(in_array($scheme,['http','https'],true)&& (empty($url['host'])||filter_var($value,FILTER_VALIDATE_URL)===false))return false;
    if(in_array($scheme,['mailto','tel'],true)&&empty($url['path']))return false;
    return !isset($url['user']) && !isset($url['pass']) && !preg_match('/[\x00-\x20\x7F]/',$value) && in_array(strtolower($url['scheme']??''),$image?['https']:['https','http','mailto','tel'],true);
}
function clean_style(string $style): string {
    $allowed=['color','background-color','font-family','font-size','font-weight','font-style','line-height','text-align','text-decoration','letter-spacing','width','max-width','min-width','height','max-height','padding','padding-top','padding-bottom','padding-left','padding-right','margin','margin-top','margin-bottom','margin-left','margin-right','border','border-width','border-color','border-style','border-radius','border-collapse','border-spacing','vertical-align','display','overflow','word-break','overflow-wrap','mso-hide','mso-line-height-rule','mso-table-lspace','mso-table-rspace','mso-padding-alt'];
    $out=[];
    foreach(explode(';',$style) as $part){
        $pair=explode(':',$part,2); if(count($pair)!==2)continue;
        $key=strtolower(trim($pair[0]));$v=trim($pair[1]);
        if(in_array($key,$allowed,true)&&strlen($v)<250&&!preg_match('/url|expression|javascript|behavior|var\(|@|[<>\\\\]/i',$v)&&preg_match('/^[a-zA-Z0-9#%.,()\s\-\x27\x22]+$/D',$v))$out[]=$key.':'.$v;
    }
    return implode(';',$out);
}
function clean_html(string $html): string {
    if(strlen($html)>500000)throw new Problem('Keep the HTML under 500 KB.');
    if(!class_exists('DOMDocument'))throw new Problem('Enable PHP DOM to edit and send HTML email.',503);
    $previous=libxml_use_internal_errors(true);
    $doc=new \DOMDocument('1.0','UTF-8');
    $doc->loadHTML('<?xml encoding="UTF-8">'.$html,LIBXML_NONET|LIBXML_NOERROR|LIBXML_NOWARNING);
    libxml_clear_errors();libxml_use_internal_errors($previous);
    $allowed=['html','head','body','div','p','span','br','hr','h1','h2','h3','h4','strong','b','em','i','u','s','small','sub','sup','blockquote','ul','ol','li','a','img','table','thead','tbody','tfoot','tr','td','th','center'];
    $drop=['script','style','iframe','frame','object','embed','form','input','button','textarea','select','svg','math','base','link','meta','title'];
    $walk=function(\DOMNode $node)use(&$walk,$allowed,$drop){
        foreach(iterator_to_array($node->childNodes) as $child){
            if($child instanceof \DOMComment || $child instanceof \DOMProcessingInstruction){$node->removeChild($child);continue;}
            if(!$child instanceof \DOMElement)continue;
            $tag=strtolower($child->tagName);
            if(in_array($tag,$drop,true)){ $node->removeChild($child);continue; }
            $walk($child);
            if(!in_array($tag,$allowed,true)){while($child->firstChild)$node->insertBefore($child->firstChild,$child);$node->removeChild($child);continue;}
            foreach(iterator_to_array($child->attributes) as $attr){
                $name=strtolower($attr->name);$value=$attr->value;
                $keep=in_array($name,['style','align','valign','width','height','cellpadding','cellspacing','border','colspan','rowspan','alt','title','role','dir','lang','bgcolor'],true);
                if($name==='href'&&$tag==='a')$keep=safe_url($value)||in_array($value,['{{website_url}}','{{unsubscribe_url}}'],true);
                if($name==='class'){$value=implode(' ',array_intersect(preg_split('/\s+/',trim($value)),email_layout()['classes']));$child->setAttribute('class',$value);$keep=$value!=='';}
                if(in_array($name,['data-tz-header','data-tz-footer'],true))$keep=$value==='standard'&&$tag==='table';
                if($name==='data-tz-preheader')$keep=$value==='standard'&&$tag==='div';
                if($name==='data-tz-content')$keep=$value==='main'&&$tag==='td';
                if($name==='data-tz-placeholder')$keep=$value==='image'&&$tag==='table';
                if($name==='data-tz-block')$keep=$tag==='table'&&(bool)preg_match('/^[a-z-]{1,32}$/D',$value);
                if($name==='data-sz-image')$keep=$tag==='img'&&$value==='stock';
                if($name==='data-tz-no-track')$keep=$value==='1';
                if($name==='clicktracking')$keep=$value==='off';
                if($name==='src'&&$tag==='img')$keep=safe_url($value,true);
                if(!$keep){$child->removeAttribute($name);continue;}
                if($name==='style')$child->setAttribute('style',clean_style($value));
            }
        }
    };
    $walk($doc);
    $body=$doc->getElementsByTagName('body')->item(0);$out='';
    if($body)foreach($body->childNodes as $child)$out.=$doc->saveHTML($child);
    return $out;
}
function personalized(string $value,array $recipient,bool $html=false): string {
    $name=trim($recipient['name']??'');$first=explode(' ',$name)[0]?:'there';
    $vars=['{{email}}'=>$recipient['email'],'{{name}}'=>$name?:'there','{{first_name}}'=>$first];
    if($html)$vars=array_map(__NAMESPACE__.'\\esc',$vars);
    return strtr($value,$vars);
}
function render_mail(array $campaign,array $recipient): array {
    $root=rtrim(config()['app_url'],'/');
    $unsubscribe=$root.'/unsubscribe.php?k='.rawurlencode(token('unsubscribe',$recipient['id']));
    $tracker=(int)$campaign['track_clicks']===1?static function(string $url)use($root,$recipient): string {
        $id=uid();query('INSERT INTO tz_links(id,recipient_id,url) VALUES(?,?,?)',[$id,$recipient['id'],$url]);
        return $root.'/track.php?kind=click&k='.rawurlencode(token('click',$id));
    }:null;
    $result=compose_email($campaign,$recipient,brand_for_campaign($campaign),$unsubscribe,$tracker);
    if((int)$campaign['track_opens']===1){
        $pixel='<img src="'.esc($root.'/track.php?kind=open&k='.rawurlencode(token('open',$recipient['id']))).'" width="1" height="1" alt="" style="border:0">';
        $result['html']=str_replace('</body>',$pixel.'</body>',$result['html']);
    }
    return $result;
}
