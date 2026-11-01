import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, segmentInfo, validateSenderId, mapDeliveryStatus } from '../app/lib/sms.ts';

test('equivalent Nigerian phone formats normalize to one deduplication key', () => {
  const variants = [
    '0803 123 4567', '+234 (803) 123-4567', '2348031234567',
    '00234 803 123 4567', '8031234567', 8031234567,
  ];
  const keys = variants.map(normalizePhone);
  assert.deepEqual([...new Set(keys)], ['+2348031234567']);
  assert.equal(normalizePhone('07012345678'), '+2347012345678');
  assert.equal(normalizePhone('09012345678'), '+2349012345678');
});

test('phone parser rejects malformed, foreign, extended, or ambiguous numbers', () => {
  for (const invalid of [
    '', ' ', null, undefined, {}, [], true, NaN, Infinity, -8031234567,
    8031234567.5, '08031234567 ext 9', '08031234567x9', '0803/123/4567',
    '0803\t1234567', '08031234567\n', '+23408031234567', '+08031234567',
    '++2348031234567', '23480312345678', '234803123456', '06031234567',
    '+447700900123', '8.031234567e9', '234+8031234567',
  ]) {
    assert.equal(normalizePhone(invalid), null, `Should reject ${String(invalid)}`);
  }
});

test('empty SMS has no billable segments', () => {
  assert.deepEqual(segmentInfo(''), {
    characters: 0, units: 0, encoding: 'GSM-7', segments: 0, perSegment: 160,
  });
});

test('GSM single-message and concatenated boundaries are counted correctly', () => {
  assert.equal(segmentInfo('a'.repeat(160)).segments, 1);
  assert.equal(segmentInfo('a'.repeat(160)).perSegment, 160);
  assert.equal(segmentInfo('a'.repeat(161)).segments, 2);
  assert.equal(segmentInfo('a'.repeat(161)).perSegment, 153);
  assert.equal(segmentInfo('a'.repeat(306)).segments, 2);
  assert.equal(segmentInfo('a'.repeat(307)).segments, 3);
});

test('GSM default alphabet includes accented and Greek characters', () => {
  const text = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà';
  const result = segmentInfo(text);
  assert.equal(result.encoding, 'GSM-7');
  assert.equal(result.units, Array.from(text).length);
});

test('GSM extension characters consume two septets', () => {
  const extensions = '\f^{}\\[~]|€';
  const result = segmentInfo(extensions);
  assert.equal(result.encoding, 'GSM-7');
  assert.equal(result.units, extensions.length * 2);
  assert.equal(segmentInfo('^'.repeat(80)).segments, 1);
  assert.equal(segmentInfo('^'.repeat(81)).segments, 2);
  assert.equal(segmentInfo('^'.repeat(153)).segments, 3);
  assert.equal(segmentInfo('a'.repeat(152) + '^' + 'a'.repeat(152)).segments, 3);
});

test('Unicode switches the entire message to UTF-16 and shorter segments', () => {
  assert.equal(segmentInfo('ọ'.repeat(70)).encoding, 'Unicode');
  assert.equal(segmentInfo('ọ'.repeat(70)).segments, 1);
  assert.equal(segmentInfo('ọ'.repeat(71)).segments, 2);
  assert.equal(segmentInfo('ọ'.repeat(134)).segments, 2);
  assert.equal(segmentInfo('ọ'.repeat(135)).segments, 3);
  assert.equal(segmentInfo('Hello ọ ^').units, 9);
  assert.equal(segmentInfo('`').encoding, 'Unicode');
});

test('astral characters consume two UTF-16 units without split surrogate pairs', () => {
  assert.deepEqual(segmentInfo('🙂'), {
    characters: 1, units: 2, encoding: 'Unicode', segments: 1, perSegment: 70,
  });
  assert.equal(segmentInfo('🙂'.repeat(35)).segments, 1);
  assert.equal(segmentInfo('🙂'.repeat(36)).segments, 2);
  assert.equal(segmentInfo('🙂'.repeat(67)).segments, 3);
});

test('sender IDs require 3–11 ASCII alphanumeric/space characters and a letter', () => {
  for (const valid of ['ABC', 'Trezad', 'Trezad SMS', 'AB123456789']) {
    assert.equal(validateSenderId(valid), true);
  }
  for (const invalid of ['AB', 'ABCDEFGHIJKL', '123456', '   ', 'Trezad_SMS', 'Trezad🙂', null, 123]) {
    assert.equal(validateSenderId(invalid), false);
  }
});

test('delivery statuses never confuse Undelivered or submission with delivery', () => {
  assert.equal(mapDeliveryStatus('Delivered'), 'delivered');
  assert.equal(mapDeliveryStatus(' DELIVRD '), 'delivered');
  assert.equal(mapDeliveryStatus('Undelivered'), 'failed');
  assert.equal(mapDeliveryStatus('NOT_DELIVERED'), 'failed');
  assert.equal(mapDeliveryStatus('delivery-failed'), 'failed');
  for (const status of ['Sent', 'Submitted', 'ACCEPTED', 'IN_QUEUE', 'Success', 'Delivered to carrier']) {
    assert.equal(mapDeliveryStatus(status), 'accepted');
  }
  for (const status of ['', 'unknown', '0', 'delivery pending confirmation', 'maybe delivered', 'delivered or failed']) {
    assert.equal(mapDeliveryStatus(status), 'unknown');
  }
});

test('documented Termii delivery reports map to actionable states', () => {
  // Exact provider terms: https://developers.termii.com/events-and-reports/
  assert.equal(mapDeliveryStatus('Message Sent'), 'accepted');
  assert.equal(mapDeliveryStatus('Message Failed'), 'failed');
  assert.equal(mapDeliveryStatus('DND Active on Phone Number'), 'failed');
  assert.equal(mapDeliveryStatus('Rejected'), 'failed');
  assert.equal(mapDeliveryStatus('Expired'), 'failed');
  assert.equal(mapDeliveryStatus('DELIVERED'), 'delivered');
  assert.equal(mapDeliveryStatus('Received'), 'unknown'); // An inbound message is not outbound delivery.
});
