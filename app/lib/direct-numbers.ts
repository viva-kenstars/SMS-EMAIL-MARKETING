import { normalizePhone } from './sms.ts';

export const MAX_DIRECT_RECIPIENTS = 5000;
const MAX_INPUT_CHARACTERS = 200000;

export interface DirectNumbersResult {
  phones: string[];
  invalid: string[];
  duplicates: number;
  entries: number;
  error: string | null;
}

/** Parse a bounded list without splitting spaces inside formatted phone numbers. */
export function parseDirectNumbers(text: string): DirectNumbersResult {
  const empty: DirectNumbersResult = {
    phones: [], invalid: [], duplicates: 0, entries: 0, error: null,
  };
  if (typeof text !== 'string') {
    return { ...empty, error: 'Enter phone numbers as text.' };
  }
  if (text.length > MAX_INPUT_CHARACTERS) {
    // No entries are parsed when the input-size limit is exceeded.
    return { ...empty, error: 'The phone-number list is too long. Use at most 200,000 characters per campaign.' };
  }

  const entries = text.split(/[\r\n,;]/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_DIRECT_RECIPIENTS) {
    return {
      ...empty,
      entries: entries.length,
      error: 'A campaign can contain at most 5,000 phone-number entries. Split this list into smaller campaigns.',
    };
  }

  const phones = new Set<string>();
  const invalid: string[] = [];
  let duplicates = 0;
  for (const entry of entries) {
    const normalized = normalizePhone(entry);
    if (normalized === null) {
      invalid.push(entry);
    } else if (phones.has(normalized)) {
      duplicates += 1;
    } else {
      phones.add(normalized);
    }
  }

  return {
    phones: Array.from(phones),
    invalid,
    duplicates,
    entries: entries.length,
    error: null,
  };
}
