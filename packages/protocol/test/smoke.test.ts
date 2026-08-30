import { expect, test } from 'vitest';
import { PROTOCOL_VERSION } from '@syncline/protocol';

test('protocol placeholder exports through the workspace alias', () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
