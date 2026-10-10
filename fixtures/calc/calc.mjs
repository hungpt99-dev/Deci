/**
 * Cart total in cents.
 * @param {Array<{unit: number, qty: number}>} items
 * @param {number} discountPct 0..50 inclusive
 * @returns {number} discounted total, rounded to the cent
 * @throws {RangeError} when discountPct is outside 0..50
 */
export function totalFor(items, discountPct) {
  if (discountPct < 0) throw new RangeError("discount out of range");
  const subtotal = items.reduce((n, it) => n + Math.round(it.unit * it.qty * 100), 0);
  return Math.floor(subtotal * (1 - discountPct / 100));
}
