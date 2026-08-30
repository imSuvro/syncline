import { expect, test } from 'vitest';
import { SERVER_VERSION } from '@syncline/server';

test('server placeholder exports through the workspace alias', () => {
  expect(SERVER_VERSION).toBe('0.1.0');
});
