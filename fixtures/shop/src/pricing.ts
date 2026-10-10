// Fixture shop: a tiny realistic codebase for end-to-end impact analysis.
// pricing.ts owns the money math; cart.ts and api.ts consume it.

export interface CartItem {
  sku: string;
  unit: number;
  qty: number;
}

/** Line total in cents, before discounts. */
export function lineTotal(item: CartItem): number {
  return Math.round(item.unit * item.qty * 100);
}

export function totalFor(items: CartItem[], discountPct: number): number {
  if (discountPct < 0 || discountPct > 50) throw new Error("discount out of range");
  const subtotal = items.reduce((n, it) => n + lineTotal(it), 0);
  return Math.round(subtotal * (1 - discountPct / 100));
}
