/** Pure WhatsApp text-template helpers shared by the browser and server. */

const MAX_BODY_LENGTH = 2000;
const MAX_VARIABLES = 20;
const MAX_VALUE_LENGTH = 1500;
const VARIABLE_KEY = /^[A-Za-z0-9_]{1,64}$/;
const PLACEHOLDER = /\{\{([A-Za-z0-9_]{1,64})\}\}/g;
const RESERVED_KEYS = new Set([
  '__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__',
  'hasOwnProperty', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf',
  'propertyIsEnumerable', 'toString', 'valueOf', 'toLocaleString',
]);
const TEMPLATE_ERROR = 'Use a WhatsApp template of 1 to 2,000 characters with up to 20 valid variables.';
const VARIABLES_ERROR = 'Provide exactly the template variables, with nonempty values of at most 1,500 characters.';
const RENDER_ERROR = 'The completed WhatsApp template must be at most 2,000 characters and contain no unresolved placeholders.';

export function validWhatsAppId(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

/** Extract unique {{key}} placeholders in first-seen order. */
export function whatsappTemplateKeys(body: string): string[] {
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY_LENGTH) {
    throw new Error(TEMPLATE_ERROR);
  }
  const keys = new Set<string>();
  const remaining = body.replace(PLACEHOLDER, (_placeholder, key: string) => {
    if (RESERVED_KEYS.has(key)) throw new Error(TEMPLATE_ERROR);
    keys.add(key);
    return '';
  });
  // Do not accept malformed tokens or silently leave dangling braces in a send.
  if (/[{}]/.test(remaining) || keys.size > MAX_VARIABLES) throw new Error(TEMPLATE_ERROR);
  return Array.from(keys);
}

function readVariables(data: Record<string, string>): Record<string, string> {
  try {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const prototype = Object.getPrototypeOf(data);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(data);
    if (keys.length > MAX_VARIABLES) throw new Error();
    const values: Record<string, string> = {};
    for (const key of keys) {
      if (typeof key !== 'string' || !VARIABLE_KEY.test(key) || RESERVED_KEYS.has(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(data, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
      const value: unknown = descriptor.value;
      if (typeof value !== 'string' || !value.trim() || value.length > MAX_VALUE_LENGTH || /[{}]/.test(value)) {
        throw new Error();
      }
      values[key] = value;
    }
    return values;
  } catch {
    throw new Error(VARIABLES_ERROR);
  }
}

/** Render only when the supplied variables exactly match the template's keys. */
export function renderWhatsAppTemplate(body: string, data: Record<string, string>): string {
  const keys = whatsappTemplateKeys(body);
  const values = readVariables(data);
  const suppliedKeys = Object.keys(values);
  if (suppliedKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(values, key))) {
    throw new Error(VARIABLES_ERROR);
  }
  const rendered = body.replace(PLACEHOLDER, (_placeholder, key: string) => values[key]);
  if (!rendered.trim() || rendered.length > MAX_BODY_LENGTH || /[{}]/.test(rendered)) {
    throw new Error(RENDER_ERROR);
  }
  return rendered;
}
