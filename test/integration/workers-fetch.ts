/**
 * A `fetch` that refuses a `this` the way the Workers runtime does.
 *
 * On Workers the global `fetch` throws `TypeError: Illegal invocation` when it
 * is called as a method of another object (`this.fetchImpl(...)`). Node's does
 * not, and neither do the arrow-function fakes, so without this a client that
 * stores `fetch` on itself passes every test and fails every call in staging.
 */
export function workersFetch(inner: typeof fetch): typeof fetch {
  return function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    return inner(input, init);
  } as typeof fetch;
}
