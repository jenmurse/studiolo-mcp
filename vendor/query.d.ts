/* Types for this module, for the one consumer that is compiled.
 *
 * `query.js` is plain ES with no build step — that is the property that keeps the client
 * dependency-free — so this file exists purely so `mcp/` can import the app's search language
 * instead of writing a second one. It is inert: nothing reads it at runtime, it ships nothing, and
 * the client still has no toolchain.
 *
 * It has to live here rather than in mcp/, because TypeScript resolves a declaration for a RELATIVE
 * import from beside the file itself; an ambient `declare module '../../js/query.js'` is ignored.
 *
 * If the shape of query.js changes, `npm run build` in mcp/ fails here — which is the point. The
 * alternative was a `@ts-ignore` on the import, and that would let the two drift silently, which is
 * exactly the failure this import was made to end. */
export type Term = { text: string; phrase: boolean; negated: boolean };
export function normalize(s: string): string;
export function parseQuery(raw: string): Term[];
export function matchesQuery(hay: string, terms: Term[]): boolean;
export function hasTerms(terms: Term[]): boolean;
