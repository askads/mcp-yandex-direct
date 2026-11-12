import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonLossless, quoteUnsafeIntegers } from "./lossless.js";

test("an id beyond 2^53 survives as a string with its exact digits", () => {
  const text = '{"result":{"AddResults":[{"Id":1926766869946816190,"Errors":[]}]}}';
  // The bug this guards: plain JSON.parse rounds the id to another, nonexistent ad.
  assert.equal(JSON.parse(text).result.AddResults[0].Id, 1926766869946816300);
  assert.deepEqual(parseJsonLossless(text), {
    result: { AddResults: [{ Id: "1926766869946816190", Errors: [] }] },
  });
});

test("numbers a JavaScript number holds exactly stay numbers", () => {
  const text = '{"Id":17674525094,"Max":9007199254740991,"Micros":300000000,"Neg":-5,"F":1.5,"E":1e21}';
  assert.equal(quoteUnsafeIntegers(text), text);
  assert.deepEqual(parseJsonLossless(text), JSON.parse(text));
});

test("the first unsafe integer and a negative one are quoted", () => {
  assert.deepEqual(parseJsonLossless("[9007199254740992,-9007199254740993,9007199254740991]"), [
    "9007199254740992",
    "-9007199254740993",
    9007199254740991,
  ]);
});

test("long digit runs inside strings are left alone, escapes included", () => {
  const text = '{"Href":"https://x.test/?id=1926766869946816190","T":"a\\"1926766869946816190\\\\","Id":1926766869946816190}';
  assert.deepEqual(parseJsonLossless(text), {
    Href: "https://x.test/?id=1926766869946816190",
    T: 'a"1926766869946816190\\',
    Id: "1926766869946816190",
  });
});

test("long fractions and exponents are not mistaken for ids", () => {
  const text = '{"A":0.12345678901234567890,"B":12345678901234567890e2,"C":1234567890123456.5}';
  assert.equal(quoteUnsafeIntegers(text), text);
});

test("ids in arrays and several per answer are all kept", () => {
  assert.deepEqual(parseJsonLossless('{"Ids":[1926766869946816190,1926766869946816446, 5]}'), {
    Ids: ["1926766869946816190", "1926766869946816446", 5],
  });
});

test("invalid JSON still throws", () => {
  assert.throws(() => parseJsonLossless('{"Id":1926766869946816190'));
});
