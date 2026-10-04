import { describe, expect, it } from 'vitest';

// CLAUDE.md rule 1: no Date.now / network / DB / AWS / apps/* imports in product sources.
const files = (
  import.meta as unknown as { glob: (p: string[], o: object) => Record<string, string> }
).glob(['./*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true });

describe('scoring-engine purity', () => {
  it('finds product source files', () => {
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(6);
  });
  for (const [name, raw] of Object.entries(files)) {
    it(`${name} has no impure dependencies`, () => {
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/Date\.now|new Date\(\s*\)|Math\.random|process\.env|fetch\(/);
      expect(src).not.toMatch(/from\s+['"](\.\.\/)+(apps|packages)\//);
      expect(src).not.toMatch(/from\s+['"](pg|aws-sdk|@aws-sdk\/[^'"]*|axios|node:[^'"]*)['"]/);
    });
  }
});
