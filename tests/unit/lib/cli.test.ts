import { describe, it, expect } from 'vitest';
import { plural, matchesGlob, detectsEnvMarker, getChiralVersion, setChiralVersion } from '../../../src/lib/cli.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('plural', () => {
  it('returns singular form when n is 1', () => {
    expect(plural(1, 'workflow')).toBe('1 workflow');
  });

  it('returns plural form when n is 0', () => {
    expect(plural(0, 'workflow')).toBe('0 workflows');
  });

  it('returns plural form when n is 2', () => {
    expect(plural(2, 'change')).toBe('2 changes');
  });
});

describe('matchesGlob', () => {
  it('matches an exact name without wildcard', () => {
    expect(matchesGlob('My Workflow', 'My Workflow')).toBe(true);
  });

  it('does not match a different name without wildcard', () => {
    expect(matchesGlob('My Workflow', 'Other Workflow')).toBe(false);
  });

  it('matches with a trailing * wildcard', () => {
    expect(matchesGlob('Customer Data Pipeline', 'Customer *')).toBe(true);
  });

  it('does not match a partial name when no wildcard covers the suffix', () => {
    expect(matchesGlob('Customer Data Pipeline', 'Customer')).toBe(false);
  });

  it('matches with ? wildcard for a single character', () => {
    expect(matchesGlob('Pipeline A', 'Pipeline ?')).toBe(true);
  });

  it('does not match when ? would need to cover more than one character', () => {
    expect(matchesGlob('Pipeline AB', 'Pipeline ?')).toBe(false);
  });

  it('escapes regex special characters in the pattern', () => {
    expect(matchesGlob('Workflow (v2)', 'Workflow (v2)')).toBe(true);
    expect(matchesGlob('Workflow v2', 'Workflow (v2)')).toBe(false);
  });
});

describe('detectsEnvMarker', () => {
  it('detects [DEV] at the end of a name', () => {
    expect(detectsEnvMarker('Order Processor [DEV]', [])).toBe(true);
  });

  it('detects [dev] at the beginning of a name', () => {
    expect(detectsEnvMarker('[dev] second workflow', [])).toBe(true);
  });

  it('detects [PROD] case-insensitively', () => {
    expect(detectsEnvMarker('Invoice Sync [prod]', [])).toBe(true);
  });

  it('detects [STAGING] anywhere in name', () => {
    expect(detectsEnvMarker('My [STAGING] Workflow', [])).toBe(true);
  });

  it('detects _dev suffix', () => {
    expect(detectsEnvMarker('Customer Pipeline_dev', [])).toBe(true);
  });

  it('detects _prod suffix case-insensitively', () => {
    expect(detectsEnvMarker('Billing_PROD', [])).toBe(true);
  });

  it('detects " - dev" suffix', () => {
    expect(detectsEnvMarker('webhook caller - dev', [])).toBe(true);
  });

  it('detects "-dev" suffix', () => {
    expect(detectsEnvMarker('webhook-dev', [])).toBe(true);
  });

  it('detects user-configured env names like devaa', () => {
    expect(detectsEnvMarker('My Workflow [devaa]', ['devaa', 'stage'])).toBe(true);
  });

  it('detects user-configured env names in _env suffix', () => {
    expect(detectsEnvMarker('Billing_stage', ['devaa', 'stage'])).toBe(true);
  });

  it('detects user-configured env names in " - env" suffix', () => {
    expect(detectsEnvMarker('webhook caller - devaa', ['devaa', 'stage'])).toBe(true);
  });

  it('returns false for a plain workflow name', () => {
    expect(detectsEnvMarker('My Workflow', [])).toBe(false);
  });

  it('returns false when name contains no env patterns', () => {
    expect(detectsEnvMarker('Order Processor', ['devaa', 'stage'])).toBe(false);
  });

  it('does not match partial word occurrences', () => {
    expect(detectsEnvMarker('development pipeline', [])).toBe(false);
  });
});

describe('getChiralVersion', () => {
  it('returns the version field from package.json', () => {
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    setChiralVersion(pkg.version);
    expect(getChiralVersion()).toBe(pkg.version);
  });
});
