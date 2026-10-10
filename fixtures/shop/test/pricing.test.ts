import { totalFor } from "../src/pricing.js";

// Sibling test for pricing.ts (discovered by sibling-name heuristic).
const cases: Array<[string, number]> = [
  ["two items, 10% off", 1620],
];

for (const [label, expected] of cases) {
  const got = totalFor([{ sku: "a", unit: 9, qty: 2 }], 10);
  if (got !== expected) throw new Error(`${label}: got ${got}, want ${expected}`);
}
