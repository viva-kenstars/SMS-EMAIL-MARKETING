/** Nigeria mobile-number and SMS helpers. No provider credentials are used here. */

/**
 * Return a Nigerian mobile number in E.164 format, or null.
 * This validates structure only; it does not establish that a SIM is active.
 */
export function normalizePhone(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !/^[+0-9 ()-]+$/.test(value)) return null;

  const compact = value.replace(/[ ()-]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  let digits: string;
  if (compact.startsWith('+')) {
    digits = compact.slice(1);
  } else if (compact.startsWith('00')) {
    digits = compact.slice(2);
  } else if (compact.startsWith('0')) {
    digits = `234${compact.slice(1)}`;
  } else if (/^[789]\d{9}$/.test(compact)) {
    digits = `234${compact}`;
  } else {
    digits = compact;
  }

  return /^234[789]\d{9}$/.test(digits) ? `+${digits}` : null;
}

// GSM 03.38 default alphabet. A literal ESC is deliberately not treated as text.
const GSM_BASIC = new Set(
  Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'),
);
const GSM_EXTENSION = new Set(Array.from('\f^{}\\[~]|€'));

export interface SegmentInfo {
  /** Unicode code points, so an ordinary emoji counts as one visible character. */
  characters: number;
  /** GSM septets or UTF-16 code units, as indicated by encoding. */
  units: number;
  encoding: 'GSM-7' | 'Unicode';
  segments: number;
  perSegment: number;
}

/**
 * Count transport units and multipart segments without splitting a GSM escape
 * sequence or a UTF-16 surrogate pair across segments.
 */
export function segmentInfo(message: string): SegmentInfo {
  const characters = Array.from(message);
  const gsm = characters.every((character) => GSM_BASIC.has(character) || GSM_EXTENSION.has(character));
  const costs = characters.map((character) => (
    gsm ? (GSM_EXTENSION.has(character) ? 2 : 1) : character.length
  ));
  const units = costs.reduce((sum, cost) => sum + cost, 0);
  const singleLimit = gsm ? 160 : 70;
  const multiLimit = gsm ? 153 : 67;
  const perSegment = units <= singleLimit ? singleLimit : multiLimit;

  let segments = 0;
  let used = 0;
  for (const cost of costs) {
    if (segments === 0 || used + cost > perSegment) {
      segments += 1;
      used = 0;
    }
    used += cost;
  }

  return {
    characters: characters.length,
    units,
    encoding: gsm ? 'GSM-7' : 'Unicode',
    segments,
    perSegment,
  };
}

/** Validate this application's 3–11 character branded sender-ID format. */
export function validateSenderId(value: unknown): boolean {
  return typeof value === 'string'
    && value.length >= 3
    && value.length <= 11
    && /^[A-Za-z0-9 ]+$/.test(value)
    && /[A-Za-z]/.test(value);
}

export type DeliveryStatus = 'delivered' | 'failed' | 'accepted' | 'unknown';

const DELIVERED_STATUSES = new Set([
  'delivered', 'delivrd', 'deliveryconfirmed', 'successfullydelivered',
]);
const FAILED_STATUSES = new Set([
  'failed', 'undelivered', 'undeliverable', 'undeliv', 'rejected', 'expired',
  'deleted', 'notdelivered', 'deliveryfailed', 'deliveryfailure', 'deliveryerror',
  'blocked', 'invalidnumber', 'dnd', 'messagefailed', 'dndactiveonphonenumber',
]);
const ACCEPTED_STATUSES = new Set([
  'accepted', 'submitted', 'sent', 'queued', 'enroute', 'pending', 'processing',
  'scheduled', 'inqueue', 'buffered', 'submittedtocarrier', 'senttocarrier',
  'deliveredtocarrier', 'messageaccepted', 'messagesent', 'success',
]);

/** Only complete known statuses match; provider acceptance is not delivery. */
export function mapDeliveryStatus(raw: string): DeliveryStatus {
  if (typeof raw !== 'string') return 'unknown';
  const normalized = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (DELIVERED_STATUSES.has(normalized)) return 'delivered';
  if (FAILED_STATUSES.has(normalized)) return 'failed';
  if (ACCEPTED_STATUSES.has(normalized)) return 'accepted';
  return 'unknown';
}
