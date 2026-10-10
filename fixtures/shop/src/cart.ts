import { totalFor, type CartItem } from "./pricing.js";

export interface Receipt {
  totalCents: number;
  itemCount: number;
}

/** Checkout total the API returns to the storefront. */
export function checkout(cart: CartItem[], discountPct: number): Receipt {
  const totalCents = totalFor(cart, discountPct);
  return { totalCents, itemCount: cart.reduce((n, it) => n + it.qty, 0) };
}
