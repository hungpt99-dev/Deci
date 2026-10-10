import { test } from "node:test";
import assert from "node:assert/strict";
import { totalFor } from "../calc.mjs";

test("happy path: two items, 10% off", () => {
  assert.equal(totalFor([{ unit: 9, qty: 2 }], 10), 1620);
});
