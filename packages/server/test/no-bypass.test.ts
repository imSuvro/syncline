// E1's structural guard. The primary enforcement is the type system: the
// arrays feeding `snapshot`/`ops` frames are declared `Permitted<T>[]`, and
// only permit.ts can mint that brand — so a raw row or entry reaching a
// data frame fails to compile. This test guards the guard: it fails if
// someone quietly adds a second minting site or unbrands those arrays.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const read = (file: string): string => readFileSync(`${srcDir}${file}`, 'utf8');
const sources = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

describe('no permission-bypass path (E1)', () => {
  test('permit.ts is the only module that mints the Permitted brand', () => {
    const minting = sources.filter((file) => /as Permitted</.test(read(file)));
    expect(minting).toEqual(['permit.ts']);
  });

  test('every data-frame payload array is declared Permitted', () => {
    const workspace = read('workspace.ts');
    // The arrays that end up as `snapshot.rows` and `ops.ops`.
    for (const decl of ['const rows: Permitted<RowState>[]', 'const visible: Permitted<LogEntry>[]']) {
      expect(workspace).toContain(decl);
    }
    // And nothing rebuilds those payloads from unbranded locals.
    expect(workspace).not.toMatch(/const (rows|visible): (RowState|LogEntry)\[\]/);
  });

  test('the evaluator is reached only through permit.ts', () => {
    const importers = sources.filter(
      (file) => file !== 'permit.ts' && /\bevaluate\b/.test(read(file)),
    );
    expect(importers).toEqual([]);
  });
});
