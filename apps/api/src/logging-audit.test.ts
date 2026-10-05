import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 9 audit (CLAUDE.md rule 6): "grep for any logging of tokens, secrets, or payloads". This turns
// the grep into a test, so a new log line that mentions one of them fails CI instead of relying on
// review. It scans every non-test source file of the API, the provider adapters, the scoring engine
// and the web app, finds each console.* call (balanced parentheses, so multi-line calls are covered)
// and checks its arguments.

const ROOT = join(__dirname, '..', '..', '..'); // repo root
const DIRS = [
  'apps/api/src',
  'apps/api/scripts',
  'packages/provider-adapters/src',
  'packages/scoring-engine/src',
  'apps/web/src',
  'infra/cdk/lib',
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f === '__fixtures__' || f === '.next') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const sources = DIRS.flatMap((d) => walk(join(ROOT, d))).filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'),
);

/** Every `console.<level>(...)` call: its source text from the opening parenthesis to the matching one. */
function consoleCalls(src: string): { level: string; args: string; line: number }[] {
  const out: { level: string; args: string; line: number }[] = [];
  const re = /console\.(log|info|warn|error|debug|trace)\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote: string | null = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push({
      level: m[1]!,
      args: src.slice(m.index + m[0].length, i - 1),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

// Words that must not appear in what is logged. `err.name` / counts / fixed text are fine; error
// MESSAGES and stacks can quote row values or payload fragments, so those are out too.
const FORBIDDEN = [
  /token/i,
  /secret/i,
  /password/i,
  /payload/i,
  /\bbody\b/i,
  /authorization/i,
  /api[_-]?key/i,
  /\.message\b/,
  /\.stack\b/,
  /JSON\.stringify\(\s*(err|error|e|req|res|event|ev)\b/,
];

// Calls that are fine despite matching: path -> reason. Empty today; keep it short and specific.
// (apps/api/db/seed/seed.ts logs a raw error object, but it is a dev-only CLI outside these dirs.)
const ALLOWED: Record<string, string> = {};

describe('logging audit (rule 6)', () => {
  it('scans a meaningful number of files and finds the known log calls (the scanner is not blind)', () => {
    expect(sources.length).toBeGreaterThan(100);
    const all = sources.flatMap((f) => consoleCalls(readFileSync(f, 'utf8')));
    expect(all.length).toBeGreaterThan(8);
    // Sanity: it can see a multi-line call.
    const strava = readFileSync(join(ROOT, 'apps/api/src/webhooks/strava/routes.ts'), 'utf8');
    expect(consoleCalls(strava).some((c) => c.args.includes('failed:'))).toBe(true);
  });

  it('no console call mentions tokens, secrets, passwords, payloads, bodies, headers, messages or stacks', () => {
    const offenders: string[] = [];
    for (const f of sources) {
      const rel = relative(ROOT, f);
      if (ALLOWED[rel]) continue;
      for (const c of consoleCalls(readFileSync(f, 'utf8'))) {
        for (const re of FORBIDDEN) {
          if (re.test(c.args))
            offenders.push(`${rel}:${c.line} console.${c.level}(…) matches ${re}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the checker itself flags what it must (self-test)', () => {
    const bad = [
      'console.log(`token=${accessToken}`)',
      'console.error(err.message)',
      'console.warn("failed", JSON.stringify(err))',
      'console.info(req.body)',
      "console.log('x', payload)",
    ];
    for (const b of bad) {
      const [c] = consoleCalls(b);
      expect(
        FORBIDDEN.some((re) => re.test(c!.args)),
        b,
      ).toBe(true);
    }
    const good = [
      'console.warn(`failed: ${err instanceof Error ? err.name : "error"}`)',
      "console.info('dropped')",
    ];
    for (const g of good) {
      const [c] = consoleCalls(g);
      expect(
        FORBIDDEN.some((re) => re.test(c!.args)),
        g,
      ).toBe(false);
    }
  });

  it('no raw `catch (e) { console.error(e) }` style dumps anywhere', () => {
    for (const f of sources) {
      const src = readFileSync(f, 'utf8');
      expect(/console\.\w+\(\s*(err|error|e)\s*\)/.test(src), relative(ROOT, f)).toBe(false);
    }
  });
});
