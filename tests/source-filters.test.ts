import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySourceFilter, detectRegions } from '../src/lib/source-filters';

test('detectRegions detects explicit US-only remote jobs', () => {
  assert.deepEqual(detectRegions({ source: 'remoteok', title: 'Backend Engineer', area: 'US only' }), ['us']);
});

test('source filter can block US-only jobs for one source', () => {
  const result = applySourceFilter(
    { source: 'remoteok', title: 'Backend Engineer', area: 'United States only' },
    { remoteok: { regions: { us: false, unspecified: true, worldwide: true } } },
  );
  assert.equal(result.passed, false);
  assert.match(result.reason ?? '', /region blocked/);
});

test('source filter can allow worldwide jobs while blocking US-only', () => {
  const result = applySourceFilter(
    { source: 'remoteok', title: 'Backend Engineer', area: 'Anywhere in the World' },
    { remoteok: { regions: { us: false, worldwide: true } } },
  );
  assert.equal(result.passed, true);
});

test('source filter blocks internship by default', () => {
  const result = applySourceFilter({ source: 'wwr', title: 'AI Engineer Internship', area: 'Worldwide' }, {});
  assert.equal(result.passed, false);
  assert.match(result.reason ?? '', /job type blocked/);
});
