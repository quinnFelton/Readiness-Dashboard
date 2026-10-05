import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 9 dashboard item: a page must not nest a <main> inside its layout's <main> (two main
// landmarks, which assistive tech reads as a bug). Static check over the app tree: wherever a layout
// renders <main>, nothing below that directory may render another one. Pages that sit under a layout
// WITHOUT <main> (the root layout, the admin layout) keep their own single <main>.

const APP = join(__dirname);
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(APP).filter((f) => /\.(tsx|ts)$/.test(f) && !/\.test\./.test(f));
const hasMain = (f: string) => /<main[\s>]/.test(readFileSync(f, 'utf8'));

describe('main landmarks', () => {
  it('there is at least one layout to check, and the root layout has no <main>', () => {
    expect(files.some((f) => f.endsWith('layout.tsx'))).toBe(true);
    expect(hasMain(join(APP, 'layout.tsx'))).toBe(false);
  });

  it('no file below a layout that renders <main> renders another <main>', () => {
    const layoutsWithMain = files.filter((f) => f.endsWith('/layout.tsx') && hasMain(f));
    const offenders: string[] = [];
    for (const layout of layoutsWithMain) {
      const dir = layout.slice(0, -'layout.tsx'.length);
      for (const f of files) {
        if (f !== layout && f.startsWith(dir) && hasMain(f)) offenders.push(f.slice(APP.length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no two nested layouts both render <main>', () => {
    const layouts = files.filter((f) => f.endsWith('/layout.tsx') && hasMain(f));
    for (const a of layouts) {
      for (const b of layouts) {
        if (a !== b)
          expect(b.startsWith(a.slice(0, -'layout.tsx'.length)), `${a} / ${b}`).toBe(false);
      }
    }
  });
});
