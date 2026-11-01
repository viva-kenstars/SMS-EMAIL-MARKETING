import sanitizeHtml from "sanitize-html";
import { MarketingError } from "./common";

const color = [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]{1,20}$/i];
const dimension = [/^(?:0|[\d.]+(?:px|em|rem|%))(?:\s+(?:0|[\d.]+(?:px|em|rem|%))){0,3}$/i];
/** Scripts, active content, remote CSS and event attributes are never retained. */
export function cleanHtml(raw: unknown): string {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > 524_288) throw new MarketingError("Use HTML content of at most 512 KB.");
  const cleaned = sanitizeHtml(raw, {
    allowedTags: ["div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup", "blockquote", "ul", "ol", "li", "a", "img", "table", "tbody", "thead", "tfoot", "tr", "th", "td", "caption", "center"],
    allowedAttributes: { "*": ["style", "align", "valign", "dir", "lang"], a: ["href", "title", "target", "rel"], img: ["src", "alt", "width", "height", "title"], table: ["width", "height", "cellpadding", "cellspacing", "border", "role", "bgcolor"], td: ["width", "height", "colspan", "rowspan", "bgcolor"], th: ["width", "height", "colspan", "rowspan", "scope", "bgcolor"] },
    allowedSchemes: ["https", "http", "mailto", "tel"], allowedSchemesByTag: { img: ["https"] }, allowProtocolRelative: false,
    nonTextTags: ["style", "script", "textarea", "option", "head", "title", "noscript"],
    allowedStyles: { "*": {
      color, "background-color": color, "font-family": [/^[a-z0-9\s,'"-]{1,160}$/i],
      "font-size": dimension, "font-weight": [/^(normal|bold|[1-9]00)$/], "font-style": [/^(normal|italic)$/],
      "text-align": [/^(left|right|center|justify)$/], "text-decoration": [/^(none|underline|line-through)$/],
      "line-height": [/^(normal|[\d.]+(?:px|em|rem|%)?)$/], "letter-spacing": dimension,
      padding: dimension, "padding-top": dimension, "padding-bottom": dimension, "padding-left": dimension, "padding-right": dimension,
      margin: dimension, "margin-top": dimension, "margin-bottom": dimension, "margin-left": dimension, "margin-right": dimension,
      width: dimension, height: dimension, "max-width": dimension, "min-width": dimension,
      border: [/^[\d.]+px\s+(solid|dashed|dotted)\s+(#[0-9a-f]{3,8}|[a-z]+)$/i], "border-top": [/^[\d.]+px\s+(solid|dashed|dotted)\s+(#[0-9a-f]{3,8}|[a-z]+)$/i], "border-bottom": [/^[\d.]+px\s+(solid|dashed|dotted)\s+(#[0-9a-f]{3,8}|[a-z]+)$/i], "border-left": [/^[\d.]+px\s+(solid|dashed|dotted)\s+(#[0-9a-f]{3,8}|[a-z]+)$/i], "border-right": [/^[\d.]+px\s+(solid|dashed|dotted)\s+(#[0-9a-f]{3,8}|[a-z]+)$/i], "border-radius": dimension,
      "border-collapse": [/^(collapse|separate)$/], "border-spacing": dimension,
      display: [/^(block|inline|inline-block|table|table-row|table-cell|none)$/],
      "vertical-align": [/^(top|middle|bottom|baseline)$/], "word-break": [/^(normal|break-word|break-all)$/],
    } },
    transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "noopener noreferrer" } }) },
    enforceHtmlBoundary: false,
  }).trim();
  if (!cleaned) throw new MarketingError("Add content to the email template.");
  return cleaned;
}
export const plainText = (html: string) => sanitizeHtml(html.replace(/<(br|\/p|\/div|\/tr|\/h[1-6])\b[^>]*>/gi, "\n"), { allowedTags: [], allowedAttributes: {} }).replace(/\n{3,}/g, "\n\n").trim();
export const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export function renderPersonalized(raw: string, contact: { email: string; name?: string }, html = false) {
  const values: Record<string, string> = { email: contact.email, name: contact.name || "there", first_name: contact.name?.trim().split(/\s+/)[0] || "there" };
  return raw.replace(/\{\{\s*(email|name|first_name)\s*\}\}/g, (_, key: string) => html ? escapeHtml(values[key]) : values[key]);
}
export function renderMessage(campaign: { html: string; subject: string; preheader: string; text_content: string }, contact: { email: string; name?: string }) {
  // Revalidate URL attributes after personalization as well as at draft save.
  const content = cleanHtml(renderPersonalized(campaign.html, contact, true));
  return {
    to: contact.email,
    subject: renderPersonalized(campaign.subject, contact).replace(/[\r\n\u0000]/g, " "),
    html: `${campaign.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(renderPersonalized(campaign.preheader, contact))}</div>` : ""}${content}`,
    text: renderPersonalized(campaign.text_content || plainText(campaign.html), contact),
  };
}
