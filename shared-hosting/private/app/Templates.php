<?php
declare(strict_types=1);
namespace Sendzad;

/** Original template catalog; loaded locally, never fetched from an external service. */
function email_catalog(): array {
    static $catalog;
    return $catalog ??= json_decode((string)file_get_contents(dirname(__DIR__).'/resources/email-templates.json'),true,512,JSON_THROW_ON_ERROR);
}
function email_layout(): array {
    static $layout;
    return $layout ??= json_decode((string)file_get_contents(dirname(__DIR__).'/resources/email-layout.json'),true,64,JSON_THROW_ON_ERROR);
}
function brand_defaults(): array {
    return ['name'=>'','website'=>'','logo_url'=>'','support_email'=>'','phone'=>'','postal_address'=>'','privacy_url'=>'','preferences_url'=>'','facebook_url'=>'','instagram_url'=>'','linkedin_url'=>'','permission_reminder'=>'To stop receiving these messages, use the unsubscribe link below.'];
}
function https_brand_url(string $url): bool {
    $parts=parse_url($url);
    return $parts!==false && ($parts['scheme']??'')==='https' && !empty($parts['host']) && !isset($parts['user']) && !isset($parts['pass']) && !preg_match('/[\x00-\x20\x7F]/',$url) && filter_var($url,FILTER_VALIDATE_URL)!==false;
}
function validate_brand(array $input): array {
    $result=brand_defaults();
    foreach($result as $key=>$default){
        $limit=$key==='permission_reminder'?700:($key==='postal_address'?1000:($key==='name'?120:2048));
        $v=text($input[$key]??$default,$limit,$key==='postal_address');
        if(in_array($key,['website','logo_url','privacy_url','preferences_url','facebook_url','instagram_url','linkedin_url'],true)&&$v!==''&&!https_brand_url($v))throw new Problem('Use a complete HTTPS URL for brand links and images.');
        if($key==='support_email'&&$v!==''&&email($v)===null)throw new Problem('Enter one valid support email address.');
        if(str_contains($v,'{{')||str_contains($v,'}}'))throw new Problem('Brand details must be plain values, not merge fields.');
        $result[$key]=$v;
    }
    return $result;
}
function brand_config(): array {
    $raw=setting('email_brand','{}');
    try{$saved=json_decode($raw,true,16,JSON_THROW_ON_ERROR);}catch(\Throwable){throw new Problem('The saved brand settings need attention.',503);}
    if(!is_array($saved))throw new Problem('The saved brand settings need attention.',503);
    return validate_brand(array_replace(brand_defaults(),$saved,['postal_address'=>setting('postal_address')]));
}
function brand_for_campaign(array $campaign): array {
    if(!empty($campaign['id'])){
        $stored=setting('campaign_brand_'.$campaign['id']);
        if($stored!==''){
            try{$b=json_decode($stored,true,16,JSON_THROW_ON_ERROR);}catch(\Throwable){throw new Problem('This campaign brand snapshot needs attention.',503);}
            if(!is_array($b))throw new Problem('This campaign brand snapshot needs attention.',503);
            return validate_brand($b);
        }
    }
    return brand_config();
}
function email_link(string $label,string $url,bool $track=true): string {
    return '<a href="'.esc($url).'"'.($track?'':' clicktracking="off" data-tz-no-track="1"').' style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.8;color:#34594f;text-decoration:underline">'.esc($label).'</a>';
}
function footer_paragraph(string $html): string {
    return '<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.8;color:#51616b">'.$html.'</p>';
}
function brand_header_html(array $brand): string {
    $b=validate_brand($brand);$site=$b['website'];$logo=$b['logo_url'];
    $identity=$logo?'<img src="'.esc($logo).'" width="144" alt="'.esc($b['name']).'" style="display:block;width:144px;max-width:100%;height:auto;border:0">':'<strong style="font-family:Arial,Helvetica,sans-serif;font-size:24px;letter-spacing:-1px;color:#173e38">'.esc($b['name']).'</strong>';
    return '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" data-tz-header="standard"><tr><td style="padding:27px 0">'.($site?'<a href="'.esc($site).'" style="text-decoration:none">'.$identity.'</a>':$identity).'</td><td align="right" class="tz-utility" style="padding:27px 0;text-align:right">'.($site?email_link('Visit website',$site):'').'</td></tr></table>';
}
function brand_footer_html(array $brand,string $unsubscribe,int $year): string {
    $b=validate_brand($brand);$contact=[];$social=[];$legal=[];
    if($b['support_email'])$contact[]=email_link($b['support_email'],'mailto:'.$b['support_email'],false);
    if($b['phone'])$contact[]=esc($b['phone']);
    foreach(['facebook_url'=>'Facebook','instagram_url'=>'Instagram','linkedin_url'=>'LinkedIn'] as $key=>$label)if($b[$key])$social[]=email_link($label,$b[$key],false);
    foreach(['privacy_url'=>'Privacy','preferences_url'=>'Email preferences'] as $key=>$label)if($b[$key])$legal[]=email_link($label,$b[$key],false);
    $legal[]=email_link('Unsubscribe',$unsubscribe,false);
    return '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" data-tz-footer="standard"><tr><td style="padding:28px 0;border-top:1px solid #dce4e2">'.
      footer_paragraph('<strong style="color:#172d37;font-size:15px">'.esc($b['name']).'</strong>').footer_paragraph(nl2br(esc($b['postal_address']))).
      ($contact?footer_paragraph(implode(' &nbsp; | &nbsp; ',$contact)):'').($social?footer_paragraph(implode(' &nbsp; / &nbsp; ',$social)):'').
      footer_paragraph(esc($b['permission_reminder'])).footer_paragraph(implode(' &nbsp; | &nbsp; ',$legal)).footer_paragraph('&copy; '.$year.' '.esc($b['name']).'. All rights reserved.').'</td></tr></table>';
}
function email_dom(string $html): \DOMDocument {
    if(!class_exists('DOMDocument'))throw new Problem('Enable PHP DOM to edit and send HTML email.',503);
    $previous=libxml_use_internal_errors(true);$doc=new \DOMDocument('1.0','UTF-8');
    try{$doc->loadHTML('<?xml encoding="UTF-8"><html><body>'.$html.'</body></html>',LIBXML_NONET|LIBXML_NOERROR|LIBXML_NOWARNING);}finally{libxml_clear_errors();libxml_use_internal_errors($previous);}
    return $doc;
}
function dom_body_html(\DOMDocument $doc): string {
    $out='';foreach($doc->getElementsByTagName('body')->item(0)->childNodes as $child)$out.=$doc->saveHTML($child);return $out;
}
function replace_email_module(\DOMDocument $doc,string $kind,string $html): bool {
    $xpath=new \DOMXPath($doc);$nodes=iterator_to_array($xpath->query('//*[@data-tz-'.$kind.']'));$inserted=false;
    foreach($nodes as $node){
        if(!$inserted){$fragment=email_dom($html);foreach(iterator_to_array($fragment->getElementsByTagName('body')->item(0)->childNodes) as $child)$node->parentNode->insertBefore($doc->importNode($child,true),$node);$inserted=true;}
        $node->parentNode?->removeChild($node);
    }
    return $inserted;
}
function example_destination(string $url): bool {
    $host=strtolower((string)(parse_url($url,PHP_URL_HOST)??''));
    return (bool)preg_match('/(^|\.)(example\.(com|net|org)|localhost)$|\.(test|invalid|example)$/',$host);
}
/** Drafts may be saved unfinished; only an explicitly requested test/launch is gated. */
function campaign_preflight(array $campaign,?array $brand=null): array {
    $b=validate_brand($brand??brand_config());$errors=[];$warnings=[];
    $source=(string)($campaign['html']??'');$doc=email_dom(clean_html($source));$xp=new \DOMXPath($doc);
    foreach(iterator_to_array($xp->query('//*[@data-tz-header or @data-tz-footer or @data-tz-preheader]')) as $node)$node->parentNode?->removeChild($node);
    $visible=implode("\n",[$campaign['subject']??'',$campaign['preheader']??'',$campaign['text_body']??'',$doc->textContent]);
    if(!$b['name'])$errors[]='Add the brand name in Settings.';
    if(!$b['postal_address'])$errors[]='Add the business postal address in Settings.';
    if(preg_match('/\[[^\]\n]{2,180}\]/u',implode("\n",$b)))$errors[]='Replace the bracketed sample details in Brand settings.';
    if($b['support_email']&&example_destination('https://'.substr(strrchr($b['support_email'],'@'),1)))$errors[]='Replace the sample support email in Brand settings.';
    if(str_contains($source,'{{website_url}}')&&!$b['website'])$errors[]='Add the HTTPS website in Brand settings.';
    foreach(['website','logo_url','privacy_url','preferences_url','facebook_url','instagram_url','linkedin_url'] as $key)if($b[$key]&&example_destination($b[$key])){$errors[]='Replace example URLs in Brand settings.';break;}
    if(preg_match('/\[[^\]\n]{2,180}\]/u',$visible))$errors[]='Replace the bracketed sample copy in the subject, design or plain text.';
    $all=implode("\n",[$source,$campaign['subject']??'',$campaign['preheader']??'',$campaign['text_body']??'']);
    preg_match_all('/\{\{\s*([^}]+)\s*\}\}/',$all,$fields);
    $known=['email','name','first_name','brand_name','website_url','postal_address','permission_reminder','year','preheader','unsubscribe_url'];
    foreach($fields[1] as $field)if(!in_array($field,$known,true)){$errors[]='Remove unsupported personalization fields.';break;}
    if($xp->query('//*[@data-tz-placeholder="image"]')->length)$errors[]='Replace or remove the sample image panels.';
    $broken=false;$examples=false;
    foreach($doc->getElementsByTagName('a') as $a){$u=$a->getAttribute('href');if(in_array($u,['{{website_url}}','{{unsubscribe_url}}'],true))continue;if(!safe_url($u))$broken=true;if(example_destination($u))$examples=true;}
    foreach($doc->getElementsByTagName('img') as $i){$u=$i->getAttribute('src');if(!safe_url($u,true))$broken=true;if(example_destination($u))$examples=true;if(!$i->hasAttribute('alt'))$warnings[]='Add alternative text to each content image.';}
    if($broken)$errors[]='Repair missing or unsafe links and image URLs.';
    if($examples)$errors[]='Replace example-domain links and images.';
    if($xp->query('//img[@data-sz-image="stock"]')->length)$warnings[]='Review stock photographs to ensure they match your products and message.';
    if(!trim($campaign['preheader']??''))$warnings[]='Add preview text to support the subject line.';
    if(!trim($campaign['text_body']??''))$warnings[]='Generate the plain-text alternative.';
    if(strlen($source)>95000)$warnings[]='This design is large. Check for inbox clipping.';
    return ['ready'=>!$errors,'errors'=>array_values(array_unique($errors)),'warnings'=>array_values(array_unique($warnings))];
}
function assert_campaign_ready(array $campaign): void {
    $result=campaign_preflight($campaign,brand_for_campaign($campaign));if(!$result['ready'])throw new Problem('Campaign needs review: '.implode(' ',$result['errors']),409);
}
function email_plaintext(string $html): string {
    $doc=email_dom(clean_html($html));$xp=new \DOMXPath($doc);
    foreach(iterator_to_array($xp->query('//*[@data-tz-header or @data-tz-footer or @data-tz-preheader]')) as $node)$node->parentNode?->removeChild($node);
    foreach($doc->getElementsByTagName('a') as $node){$u=$node->getAttribute('href');if($u&&!str_contains($u,'unsubscribe'))$node->appendChild($doc->createTextNode(' ('.$u.')'));}
    foreach(iterator_to_array($doc->getElementsByTagName('br')) as $node)$node->parentNode->replaceChild($doc->createTextNode("\n"),$node);
    foreach(['p','h1','h2','h3','h4','li','tr','div','table'] as $tag)foreach($doc->getElementsByTagName($tag) as $node)$node->appendChild($doc->createTextNode("\n\n"));
    return trim((string)preg_replace('/\n{3,}/',"\n\n",(string)preg_replace('/[ \t]+\n/',"\n",$doc->textContent)));
}
function merge_values(array $b,array $r,array $c,string $unsubscribe,int $year): array {
    $name=trim((string)($r['name']??''));$first=preg_split('/\s+/u',$name)[0]?:'there';
    return ['{{email}}'=>(string)($r['email']??''),'{{name}}'=>$name?:'there','{{first_name}}'=>$first,'{{brand_name}}'=>$b['name'],'{{website_url}}'=>$b['website'],'{{postal_address}}'=>$b['postal_address'],'{{permission_reminder}}'=>$b['permission_reminder'],'{{year}}'=>(string)$year,'{{preheader}}'=>(string)($c['preheader']??''),'{{unsubscribe_url}}'=>$unsubscribe];
}
/** Pure rendering seam for tests: a supplied tracker only rewrites ordinary content links. */
function compose_email(array $campaign,array $recipient,array $brand,string $unsubscribe,?callable $trackLink=null,?int $year=null): array {
    $b=validate_brand($brand);$year??=(int)gmdate('Y');$vars=merge_values($b,$recipient,$campaign,$unsubscribe,$year);
    $raw=clean_html((string)$campaign['html']);$raw=strtr($raw,array_map(__NAMESPACE__.'\\esc',$vars));
    $doc=email_dom(clean_html($raw));$xp=new \DOMXPath($doc);
    foreach(iterator_to_array($xp->query('//*[@data-tz-preheader]')) as $node)$node->parentNode?->removeChild($node);
    replace_email_module($doc,'header',brand_header_html($b));
    if(!replace_email_module($doc,'footer',brand_footer_html($b,$unsubscribe,$year))){
        $fallback=email_dom('<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 24px">'.brand_footer_html($b,$unsubscribe,$year).'</td></tr></table>');
        foreach(iterator_to_array($fallback->getElementsByTagName('body')->item(0)->childNodes) as $child)$doc->getElementsByTagName('body')->item(0)->appendChild($doc->importNode($child,true));
    }
    if($trackLink)foreach($doc->getElementsByTagName('a') as $a){
        $u=$a->getAttribute('href');if($u===$unsubscribe||$a->hasAttribute('data-tz-no-track')||!preg_match('#^https?://#i',$u)||!safe_url($u))continue;
        $isFooter=false;for($parent=$a->parentNode;$parent;$parent=$parent->parentNode)if($parent instanceof \DOMElement&&$parent->hasAttribute('data-tz-footer')){$isFooter=true;break;}
        if(!$isFooter)$a->setAttribute('href',$trackLink($u));
    }
    $preheader=strtr((string)($campaign['preheader']??''),$vars);
    $html='<div data-tz-preheader="standard" class="tz-preheader" style="display:none;max-height:0;overflow:hidden;mso-hide:all">'.esc($preheader).'</div>'.dom_body_html($doc);
    $html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'.esc($b['name']).'</title><style>'.email_layout()['css'].'</style></head><body style="margin:0;padding:0;background-color:#edf2f0"><!--[if mso]><table role="presentation" align="center" width="640" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->'.$html.'<!--[if mso]></td></tr></table><![endif]--></body></html>';
    $plain=(string)($campaign['text_body']??'');if(!trim($plain))$plain=email_plaintext($campaign['html']);
    $plain=strtr($plain,$vars)."\n\n---\n".$b['name']."\n".$b['postal_address']."\n".$b['permission_reminder'];
    if($b['support_email'])$plain.="\nContact: ".$b['support_email'];if($b['phone'])$plain.="\nPhone: ".$b['phone'];
    foreach(['website'=>'Website','privacy_url'=>'Privacy','preferences_url'=>'Email preferences','facebook_url'=>'Facebook','instagram_url'=>'Instagram','linkedin_url'=>'LinkedIn'] as $key=>$label)if($b[$key])$plain.="\n$label: ".$b[$key];
    $plain.="\nUnsubscribe: ".$unsubscribe."\nCopyright ".$year.' '.$b['name'];
    return ['html'=>$html,'text'=>$plain,'subject'=>strtr($campaign['subject'],$vars),'unsubscribe'=>$unsubscribe];
}
