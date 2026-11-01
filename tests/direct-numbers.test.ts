import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DIRECT_RECIPIENTS, parseDirectNumbers } from '../app/lib/direct-numbers.ts';

test('accepts complete Nigerian local, +234, 234, and 00234 formats in first-seen order', () => {
  assert.deepEqual(parseDirectNumbers('08031234567\n+2349012345678\n2347012345678\n002348121234567'), {
    phones: ['+2348031234567', '+2349012345678', '+2347012345678', '+2348121234567'],
    invalid: [],
    duplicates: 0,
    entries: 4,
    error: null,
  });
});

test('supports mixed newline, comma and semicolon separators and ignores blank entries', () => {
  const parsed = parseDirectNumbers(' ,08031234567;\r\n +2349012345678 , ; 2347012345678\r002348121234567;\n');
  assert.deepEqual(parsed.phones, ['+2348031234567', '+2349012345678', '+2347012345678', '+2348121234567']);
  assert.equal(parsed.entries, 4);
  assert.equal(parsed.error, null);
});

test('preserves spaces, parentheses and hyphens inside a formatted number', () => {
  const parsed = parseDirectNumbers(' 0803 123 4567 ; +234 (901) 234-5678 ');
  assert.deepEqual(parsed.phones, ['+2348031234567', '+2349012345678']);
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.entries, 2);
  const spaceSeparatedNumbers = parseDirectNumbers('08031234567 09012345678');
  assert.deepEqual(spaceSeparatedNumbers.phones, []);
  assert.deepEqual(spaceSeparatedNumbers.invalid, ['08031234567 09012345678']);
});

test('normalizes equivalent valid numbers and counts only additional valid occurrences', () => {
  const parsed = parseDirectNumbers('08031234567,+2348031234567;2348031234567\n002348031234567;8031234567;08031234568;bad;bad');
  assert.deepEqual(parsed.phones, ['+2348031234567', '+2348031234568']);
  assert.deepEqual(parsed.invalid, ['bad', 'bad']);
  assert.equal(parsed.duplicates, 4);
  assert.equal(parsed.entries, 8);
});

test('reports original trimmed malformed, incomplete and foreign entries', () => {
  const invalid = ['0803', '+23408031234567', '+447700900123', '08031234567 ext 9', 'not a phone', '0803123456'];
  const parsed = parseDirectNumbers(`08031234567; ${invalid.join(' ; ')} `);
  assert.deepEqual(parsed.phones, ['+2348031234567']);
  assert.deepEqual(parsed.invalid, invalid);
  assert.equal(parsed.entries, 7);
  assert.equal(parsed.error, null);
});

test('empty input and separators-only input return no entries and no error', () => {
  for (const value of ['', '  ', '\r\n,,;; \n\t']) {
    assert.deepEqual(parseDirectNumbers(value), {
      phones: [], invalid: [], duplicates: 0, entries: 0, error: null,
    });
  }
});

test('allows exactly 5,000 entries and rejects an oversized batch without a partial recipient list', () => {
  assert.equal(MAX_DIRECT_RECIPIENTS, 5000);
  const numbers = Array.from({ length: MAX_DIRECT_RECIPIENTS }, (_, index) => `080${String(index).padStart(8, '0')}`);
  const maximum = parseDirectNumbers(numbers.join('\n'));
  assert.equal(maximum.error, null);
  assert.equal(maximum.phones.length, 5000);
  assert.equal(maximum.entries, 5000);

  const oversized = parseDirectNumbers([...numbers, '08031234567'].join('\n'));
  assert.equal(oversized.entries, 5001);
  assert.deepEqual(oversized.phones, []);
  assert.match(oversized.error ?? '', /5,000/);
});

test('the entry cap includes duplicates and invalid entries before deduplication', () => {
  const parsed = parseDirectNumbers(['08031234567', ...Array.from({ length: 5000 }, () => 'bad')].join(';'));
  assert.equal(parsed.entries, 5001);
  assert.deepEqual(parsed.phones, []);
  assert.notEqual(parsed.error, null);
  assert.notEqual(parseDirectNumbers(Array.from({ length: 5001 }, () => '08031234567').join(',')).error, null);
});

test('enforces the input character cap before parsing and returns no partial recipients', () => {
  const number = '08031234567';
  const maximum = number + ' '.repeat(200000 - number.length);
  assert.deepEqual(parseDirectNumbers(maximum).phones, ['+2348031234567']);
  assert.equal(parseDirectNumbers(maximum).error, null);
  const oversized = parseDirectNumbers(maximum + ' ');
  assert.deepEqual(oversized.phones, []);
  assert.deepEqual(oversized.invalid, []);
  assert.equal(oversized.entries, 0);
  assert.match(oversized.error ?? '', /200,000/);
});
