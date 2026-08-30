import { describe, expect, test } from 'vitest';
import {
  canWrite,
  evaluate,
  validateRuleset,
  type Op,
  type Principal,
  type Ruleset,
} from '@syncline/protocol';
import { DEMO_RULESET } from 'syncline-demo-schema';

const priya: Principal = { userId: 'priya', role: 'owner' };
const maya: Principal = { userId: 'maya', role: 'editor' };
const theo: Principal = { userId: 'theo', role: 'viewer' };

describe('evaluate (ADR-003)', () => {
  test('members read issues regardless of role', () => {
    for (const p of [priya, maya, theo]) {
      expect(evaluate(DEMO_RULESET, p, 'issues', { title: 'x' }).read).toBe(true);
    }
  });

  test('unknown table is invisible', () => {
    expect(evaluate(DEMO_RULESET, priya, 'secrets', {}).read).toBe(false);
  });

  test('field masking yields a mask only when readFields exist', () => {
    expect(evaluate(DEMO_RULESET, theo, 'issues', { title: 'x' }).fieldMask).toBeUndefined();
    const masked: Ruleset = {
      version: 1,
      tables: {
        issues: {
          read: { kind: 'member' },
          readFields: { salary: { kind: 'role', atLeast: 'owner' } },
          write: { kind: 'role', atLeast: 'owner' },
        },
      },
    };
    expect(evaluate(masked, theo, 'issues', { title: 'x', salary: 9 }).fieldMask).toEqual(['title']);
    expect(evaluate(masked, priya, 'issues', { title: 'x', salary: 9 }).fieldMask).toEqual(['title', 'salary']);
  });
});

describe('canWrite (ADR-003)', () => {
  const update = (table: string, field: string): Op => ({ kind: 'update', table, rowId: 'r', field, value: 'v' });

  test('editors write issues, viewers do not', () => {
    expect(canWrite(DEMO_RULESET, maya, update('issues', 'title'), {})).toBe(true);
    expect(canWrite(DEMO_RULESET, theo, update('issues', 'title'), {})).toBe(false);
  });

  test('membership creates and role changes are owner-only', () => {
    const invite: Op = { kind: 'create', table: 'memberships', rowId: 'sam', fields: { userId: 'sam', role: 'editor' } };
    expect(canWrite(DEMO_RULESET, priya, invite, {})).toBe(true);
    expect(canWrite(DEMO_RULESET, maya, invite, {})).toBe(false);
    expect(canWrite(DEMO_RULESET, maya, update('memberships', 'role'), { userId: 'theo' })).toBe(false);
  });

  test('self-removal is allowed, removing others is owner-only', () => {
    const remove = (rowId: string): Op => ({ kind: 'delete', table: 'memberships', rowId });
    expect(canWrite(DEMO_RULESET, maya, remove('maya'), { userId: 'maya', role: 'editor' })).toBe(true);
    expect(canWrite(DEMO_RULESET, maya, remove('theo'), { userId: 'theo', role: 'viewer' })).toBe(false);
    expect(canWrite(DEMO_RULESET, priya, remove('theo'), { userId: 'theo', role: 'viewer' })).toBe(true);
  });
});

describe('validateRuleset (ADR-003 review ruling)', () => {
  test('demo ruleset is valid', () => {
    expect(validateRuleset(DEMO_RULESET)).toEqual([]);
  });

  test('write-without-read is rejected', () => {
    const invalid: Ruleset = {
      version: 1,
      tables: {
        notes: {
          read: { kind: 'member' },
          readFields: { hidden: { kind: 'role', atLeast: 'owner' } },
          write: { hidden: { kind: 'role', atLeast: 'editor' } },
        },
      },
    };
    expect(validateRuleset(invalid).length).toBeGreaterThan(0);
  });
});
