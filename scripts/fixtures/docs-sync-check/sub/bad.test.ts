import { describe, it } from 'node:test';

// A run id inside a test name must be flagged.
describe('leakage via test name a99__202601010101', () => {
  it('passes', () => {});
});
