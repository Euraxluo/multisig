// vitest→node:test 兼容层：仓库未安装 vitest，用 node:test 语义对齐
import { test as it } from 'node:test';
import assert from 'node:assert/strict';
export const describe = (name: string, fn: () => void) => { fn() };
export const it_ = it;
type Matcher = string | RegExp | Error | undefined;
export const expect = (actual: unknown) => ({
  toBe: (e: unknown) => assert.strictEqual(actual, e),
  toEqual: (e: unknown) => assert.deepStrictEqual(actual, e),
  toThrow: (m?: Matcher) => assert.throws(() => { if (typeof actual === 'function') (actual as () => unknown)(); }, m as never),
  toBeTruthy: () => assert.ok(actual),
  toBeInstanceOf: (c: new (...a: never[]) => unknown) => assert.ok(actual instanceof c),
});
export { it };
