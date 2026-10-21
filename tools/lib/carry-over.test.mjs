import { test } from "node:test";
import assert from "node:assert/strict";
import { carryOver } from "./carry-over.mjs";

test("uma app que falhou mantém a entrada que já estava publicada", () => {
  const published = [{ id: "a", release: { versionName: "1.0" } }, { id: "b" }];
  const { carried, orphans } = carryOver(published, ["a"]);
  assert.deepEqual(carried, [published[0]]);
  assert.deepEqual(orphans, []);
});

test("sem entrada anterior, a app fica de fora e é reportada", () => {
  const { carried, orphans } = carryOver([{ id: "a" }], ["nova"]);
  assert.deepEqual(carried, []);
  assert.deepEqual(orphans, ["nova"]);
});

test("um id repetido não duplica a entrada", () => {
  const { carried } = carryOver([{ id: "a" }], ["a", "a"]);
  assert.equal(carried.length, 1);
});

test("sem índice anterior ou sem falhas não rebenta", () => {
  assert.deepEqual(carryOver(null, ["a"]), { carried: [], orphans: ["a"] });
  assert.deepEqual(carryOver([{ id: "a" }], []), { carried: [], orphans: [] });
  assert.deepEqual(carryOver(undefined, undefined), { carried: [], orphans: [] });
});
