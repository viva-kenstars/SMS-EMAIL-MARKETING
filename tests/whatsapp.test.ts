import test from 'node:test';
import assert from 'node:assert/strict';
import { validWhatsAppId, whatsappTemplateKeys, renderWhatsAppTemplate } from '../app/lib/whatsapp.ts';

test('WhatsApp IDs accept bounded documented identifier characters only', () => {
  for (const value of ['a', 'device_123', 'template.01-2', 'A'.repeat(128)]) {
    assert.equal(validWhatsAppId(value), true);
  }
  for (const value of ['', 'A'.repeat(129), ' spaces ', 'a/b', 'a:b', 'a\n', null, undefined, 123, []]) {
    assert.equal(validWhatsAppId(value), false);
  }
});

test('template keys are unique in first-seen order and support named or numeric variables', () => {
  assert.deepEqual(whatsappTemplateKeys('Hello {{name}}, join {{1}}. Thanks {{name}} from {{community_name}}.'), ['name', '1', 'community_name']);
  assert.deepEqual(whatsappTemplateKeys('A static approved message.'), []);
  assert.deepEqual(whatsappTemplateKeys(`Hello {{${'a'.repeat(64)}}}`), ['a'.repeat(64)]);
});

test('malformed, dangling and prototype-reserved placeholders are rejected', () => {
  for (const body of [
    '{{name}', '{name}}', '{{ name }}', '{{}}', '{{a-b}}', '{{name', 'name}}',
    '{{{name}}}', '{{name}}}', '{literal}', `{{${'a'.repeat(65)}}}`,
    '{{__proto__}}', '{{constructor}}', '{{prototype}}', '{{toString}}', '{{hasOwnProperty}}',
  ]) {
    assert.throws(() => whatsappTemplateKeys(body), /valid variables/);
  }
});

test('template body and unique-variable limits are enforced', () => {
  assert.deepEqual(whatsappTemplateKeys('a'.repeat(2000)), []);
  for (const body of ['', '   ', 'a'.repeat(2001)]) {
    assert.throws(() => whatsappTemplateKeys(body));
  }
  const twenty = Array.from({ length: 20 }, (_, index) => `{{v${index}}}`).join(' ');
  assert.equal(whatsappTemplateKeys(twenty).length, 20);
  assert.equal(whatsappTemplateKeys(`${twenty} {{v0}}`).length, 20);
  assert.throws(() => whatsappTemplateKeys(`${twenty} {{v20}}`));
});

test('render substitutes exact variables literally without replacement-token interpretation', () => {
  assert.equal(renderWhatsAppTemplate('Hello {{name}}, join {{link}}. {{name}}!', {
    name: 'Kennedy', link: 'https://example.com/invite?label=$&',
  }), 'Hello Kennedy, join https://example.com/invite?label=$&. Kennedy!');
  assert.equal(renderWhatsAppTemplate('Ẹ káàrọ̀ {{name}} 👋', { name: 'Ada' }), 'Ẹ káàrọ̀ Ada 👋');
  assert.equal(renderWhatsAppTemplate('A static approved message.', {}), 'A static approved message.');
  const safeNullPrototype = Object.create(null) as Record<string, string>;
  safeNullPrototype.name = 'Ada';
  assert.equal(renderWhatsAppTemplate('Hello {{name}}', safeNullPrototype), 'Hello Ada');
});

test('missing and extra variables are rejected instead of silently sending incomplete content', () => {
  const cases: Record<string, string>[] = [{}, { name: 'Ada', extra: 'x' }, { other: 'Ada' }];
  for (const data of cases) {
    assert.throws(() => renderWhatsAppTemplate('Hello {{name}}', data), /exactly the template variables/);
  }
  assert.throws(() => renderWhatsAppTemplate('Static message', { extra: 'x' }));
});

test('variable values must be bounded nonempty strings without unresolved braces', () => {
  assert.equal(renderWhatsAppTemplate('{{name}}', { name: 'a'.repeat(1500) }).length, 1500);
  for (const value of ['', '   ', 'a'.repeat(1501), '{{another}}', '{dangling', 123, null, [], {}]) {
    assert.throws(() => renderWhatsAppTemplate('{{name}}', { name: value } as unknown as Record<string, string>));
  }
  assert.throws(() => renderWhatsAppTemplate('a'.repeat(501) + '{{name}}', { name: 'a'.repeat(1500) }), /completed WhatsApp template/);
  assert.equal(renderWhatsAppTemplate('a'.repeat(500) + '{{name}}', { name: 'a'.repeat(1500) }).length, 2000);
});

test('arrays, inherited values, prototype keys, accessors and symbol keys are rejected', () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'name', { enumerable: true, get() { getterCalls += 1; return 'Ada'; } });
  const nonEnumerable = Object.defineProperty({}, 'name', { enumerable: false, value: 'Ada' });
  const invalid = [
    null, [], ['Ada'], Object.create({ name: 'Ada' }), accessor, nonEnumerable,
    JSON.parse('{"name":"Ada","__proto__":"x"}'),
    { name: 'Ada', constructor: 'x' }, { name: 'Ada', prototype: 'x' },
    { name: 'Ada', [Symbol('hidden')]: 'x' },
  ];
  for (const data of invalid) {
    assert.throws(() => renderWhatsAppTemplate('{{name}}', data as Record<string, string>));
  }
  assert.equal(getterCalls, 0);
});

test('validation errors never echo template contents or variable values', () => {
  const sensitive = 'private-contact-or-credential';
  assert.throws(() => renderWhatsAppTemplate('{{name}}', { name: sensitive, extra: sensitive }), (error: Error) => {
    assert.equal(error.message.includes(sensitive), false);
    return true;
  });
});
