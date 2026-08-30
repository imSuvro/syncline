import { expect, test } from 'vitest';
import { CLIENT_VERSION } from '@syncline/client';

test('client placeholder exports through the workspace alias', () => {
  expect(CLIENT_VERSION).toBe('0.1.0');
});
