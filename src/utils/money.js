/**
 * Money helpers.
 *
 * Every amount is carried around the server as an INTEGER number of minor
 * units (paise, cents). Storing money as a float is the classic expense
 * tracker bug: 0.1 + 0.2 is 0.30000000000000004, so totals drift by a paisa
 * per few hundred rows and a budget never quite adds up.
 */
import { badRequest } from './errors.js';

export const MINOR_UNITS = 100;

/** 99,999,999.99 — large enough for any real invoice, small enough that a
 *  SUM of them stays inside the safe-integer range JSON can represent. */
export const MAX_AMOUNT_MINOR = 9_999_999_999;

// Up to 12 whole digits and at most 2 decimals. Anything else — "1e5", "12.",
// "-5", "1,250" — is rejected rather than silently coerced.
const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Turn user input ("1250", "1250.5", 1250.5) into minor units.
 *
 * @param {unknown} value
 * @param {string}  [field]   Name used in the error message.
 * @param {object}  [options]
 * @param {boolean} [options.allowZero]  Budgets may be 0; an expense may not.
 * @returns {number} whole minor units
 */
export function parseAmount(value, field = 'amount', { allowZero = false } = {}) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw badRequest(`"${field}" must be a number.`);
  }
  if (value === null || value === undefined || value === '') {
    throw badRequest(`"${field}" is required.`);
  }

  const text = String(value).trim();
  if (!AMOUNT_PATTERN.test(text)) {
    throw badRequest(`"${field}" must be a positive amount such as 1250 or 1250.50.`);
  }

  const [whole, fraction = ''] = text.split('.');
  // String arithmetic, not value * 100: 19.99 * 100 is 1998.9999999999998.
  const minor = Number(whole) * MINOR_UNITS + Number(fraction.padEnd(2, '0'));

  if (minor === 0 && !allowZero) {
    throw badRequest(`"${field}" must be greater than zero.`);
  }
  if (minor > MAX_AMOUNT_MINOR) {
    throw badRequest(`"${field}" must be ${formatAmount(MAX_AMOUNT_MINOR)} or less.`);
  }
  return minor;
}

/** As above, but `null` for an absent value. */
export function optionalAmount(value, field = 'amount', options = {}) {
  if (value === null || value === undefined || value === '') return null;
  return parseAmount(value, field, options);
}

/** 125050 -> "1250.50". Negative input (an overspend) keeps its sign. */
export function formatAmount(minor) {
  const value = Math.trunc(Number(minor ?? 0));
  if (!Number.isFinite(value)) return '0.00';

  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / MINOR_UNITS)}.${String(abs % MINOR_UNITS).padStart(2, '0')}`;
}

/**
 * The shape every amount leaves the API in: the exact integer for maths, and
 * a decimal string that can be sent straight back in a PATCH.
 */
export const amountFields = (minor) => ({
  amountMinor: minor,
  amount: formatAmount(minor)
});
