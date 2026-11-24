/**
 * 源码级守卫（issue I1）：本文件不测任何 JS 行为，而是读取
 * `contracts/agent_vault/sources/` 的 Move 源码文本，钉住只能在源码层面表达的约束：
 *
 * 1. 写侧高危入口的可见性 —— `mark_org_created`（一次性组织创建门：对共享
 *    DkgSession 落下不可撤销标记，函数体无验签/发送者/状态门禁，I1 修复收紧为
 *    包内可见）与 `take_genesis_stakes`（返回值可自由处分的 Balance 扫入，审计
 *    H-02 已收紧）必须是 `public(package) fun`。匹配在「剥离注释 + 空白归一」
 *    后的全文上做跨行正则计数：该函数的声明必须恰好一处，且每一处都必须带
 *    (package)——注释里放假签名、把签名拆成多行改宽（红队演示过的两个绕过
 *    形态）都会被抓；改宽成 public fun / entry fun 让「全部带 (package)」失
 *    败，删除让计数归零失败。名单常量在下方，后续再有只该包内可见的写侧
 *    函数，往 PACKAGE_ONLY_FUNCTIONS 加一行即可。
 * 2. 全部 `sources/*.move` 中名字以 `_for_testing` 结尾的函数，其所在声明
 *    （归一化文本中向上最近的 `}` / `;` 边界之内）必须含 `#[test_only]` ——
 *    测试后门不得以生产可见性发布。
 *
 * 为什么住在 SDK 目录：仓库现成的 CI JS 测试门（`pnpm test:sdk` 的 glob 直接
 * 命中本目录）是唯一无需新增基建、随每次提交强制执行的守卫落点。Move 侧
 * `sui move test` 表达不了「包外不可见」—— 同包测试模块本来就能调
 * `public(package)`；跨包探针只在修复时手工构建一次。源码文本断言因此是唯一
 * 可自动化的形态；真正的防线仍是编译期可见性，本文件是防回归的哨兵。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from './vitest-shim';

const here = dirname(fileURLToPath(import.meta.url));
// packages/multisig/src/agent-vault/org/ → 仓库根/contracts/agent_vault/sources
const sourcesDir = resolve(here, '..', '..', '..', '..', '..', 'contracts', 'agent_vault', 'sources');

/**
 * 只允许 agent_vault 包内调用的函数白名单：{ module, fun }。
 * 后续收紧新的写侧函数时，在此追加一行即可。
 */
const PACKAGE_ONLY_FUNCTIONS: ReadonlyArray<{ module: string; fun: string }> = [
  { module: 'dkg_committee.move', fun: 'mark_org_created' }, // I1：一次性组织创建门（写入侧）
  { module: 'dkg_committee.move', fun: 'take_genesis_stakes' }, // 审计 H-02：创世质押扫入
];

/**
 * 剥掉行注释与块注释后把全部空白折叠为单个空格。签名在源码里的换行/缩进
 * 差异消失，正则得以跨行匹配；注释里的假声明（红队演示的诱饵形态）不参与
 * 匹配。本文件只做文本断言，不还原字符串字面量——sources/ 的字面量中没有
 * 形如函数声明的片段。
 */
const normalizeSource = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\s+/g, ' ');

const countMatches = (text: string, re: RegExp): number => [...text.matchAll(re)].length;

describe('agent_vault source guards (I1)', () => {
  it('sources 目录解析正确（防路径漂移的自检）', () => {
    const text = readFileSync(join(sourcesDir, 'dkg_committee.move'), 'utf8');
    assert.ok(
      text.includes('module agent_vault::dkg_committee'),
      `未在 ${sourcesDir} 找到 dkg_committee.move —— 本测试文件或源码目录被移动，需同步更新 sourcesDir`,
    );
  });

  it('PACKAGE_ONLY_FUNCTIONS 中的函数必须恰好一处声明且为 public(package) fun', () => {
    for (const { module, fun } of PACKAGE_ONLY_FUNCTIONS) {
      const text = normalizeSource(readFileSync(join(sourcesDir, module), 'utf8'));
      // 正向：public(package) 修饰的该函数声明必须恰好一处。
      // 改宽成 public fun / entry fun、或整段删除，都会让这里归零而失败。
      const packageOnly = countMatches(text, new RegExp(`public\\(package\\)\\s+fun\\s+${fun}\\s*[<(]`, 'g'));
      assert.ok(
        packageOnly === 1,
        `${module}: ${fun} 应恰好有一处 public(package) fun 声明（归一化后跨行计数），实际 ${packageOnly}`,
      );
      // 反向：同名的每一处声明都必须带 (package)。签名拆行改宽后仍会被
      // 计入 allDecls 而不计入 packageOnly，总数即不相等。
      const allDecls = countMatches(text, new RegExp(`\\bfun\\s+${fun}\\s*[<(]`, 'g'));
      assert.ok(
        allDecls === packageOnly,
        `${module}: ${fun} 存在 ${allDecls - packageOnly} 处非包内可见的声明（public fun / entry fun，含拆行与注释外形态）`,
      );
    }
  });

  it('所有 _for_testing 函数的声明带 #[test_only] 属性', () => {
    const files = readdirSync(sourcesDir).filter((f) => f.endsWith('.move'));
    assert.ok(files.length > 0, `sources 目录为空：${sourcesDir}`);
    const violations: string[] = [];
    for (const file of files) {
      const text = normalizeSource(readFileSync(join(sourcesDir, file), 'utf8'));
      for (const m of text.matchAll(/\bfun\s+\w+_for_testing\s*[<(]/g)) {
        // 归一化文本里，从向上最近的项边界（} 或 ;）到 fun 之间是属性区；
        // #[test_only] 必须出现在其中（隔注释/空行经归一化后同样成立）。
        const at = m.index ?? 0;
        const itemStart = Math.max(text.lastIndexOf('}', at), text.lastIndexOf(';', at)) + 1;
        if (!text.slice(itemStart, at).includes('#[test_only]')) {
          violations.push(`${file}: …${m[0].trim()}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `以下 _for_testing 函数缺少 #[test_only]：\n${violations.join('\n')}`,
    );
  });
});
