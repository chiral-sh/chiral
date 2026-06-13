import { describe, it, expect } from 'vitest';
import {
  validateNoDuplicateTargets,
  validateNoCircularMapping,
  WorkflowMap,
} from '../../../src/state/workflows.js';
import { UserError } from '../../../src/lib/errors.js';

const CLEAN_MAP: WorkflowMap = {
  version: 1,
  workflows: {
    'order-processor': {
      dev: { name: 'Order Processor [DEV]' },
      prod: { name: 'Order Processor' },
    },
    'invoice-sender': {
      dev: { name: 'Invoice Sender [DEV]' },
      prod: { name: 'Invoice Sender' },
    },
  },
};

describe('validateNoDuplicateTargets', () => {
  it('passes for a clean map', () => {
    expect(() => validateNoDuplicateTargets(CLEAN_MAP, 'dev', 'prod')).not.toThrow();
  });

  it('throws naming both logical keys when two entries share a target name', () => {
    const map: WorkflowMap = {
      version: 1,
      workflows: {
        'order-processor': { dev: { name: 'Order A' }, prod: { name: 'Shared Target' } },
        'invoice-sender': { dev: { name: 'Invoice A' }, prod: { name: 'Shared Target' } },
      },
    };
    expect(() => validateNoDuplicateTargets(map, 'dev', 'prod')).toThrow(UserError);
    try {
      validateNoDuplicateTargets(map, 'dev', 'prod');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('order-processor');
      expect(msg).toContain('invoice-sender');
      expect(msg).toContain('Shared Target');
    }
  });

  it('ignores entries missing one side of the env pair', () => {
    const map: WorkflowMap = {
      version: 1,
      workflows: {
        'order-processor': { dev: { name: 'Order A' } },
        'invoice-sender': { prod: { name: 'Order A' } },
      },
    };
    expect(() => validateNoDuplicateTargets(map, 'dev', 'prod')).not.toThrow();
  });
});

describe('validateNoCircularMapping', () => {
  it('passes for a clean map', () => {
    expect(() => validateNoCircularMapping(CLEAN_MAP, 'dev', 'prod')).not.toThrow();
  });

  it('throws on an A->B / B->A cycle for the env pair', () => {
    const map: WorkflowMap = {
      version: 1,
      workflows: {
        'workflow-a': { dev: { name: 'Order Processor' }, prod: { name: 'Invoice Sender' } },
        'workflow-b': { dev: { name: 'Invoice Sender' }, prod: { name: 'Order Processor' } },
      },
    };
    expect(() => validateNoCircularMapping(map, 'dev', 'prod')).toThrow(UserError);
    try {
      validateNoCircularMapping(map, 'dev', 'prod');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('workflow-a');
      expect(msg).toContain('workflow-b');
    }
  });

  it('ignores entries missing one side of the env pair', () => {
    const map: WorkflowMap = {
      version: 1,
      workflows: {
        'workflow-a': { dev: { name: 'Order Processor' } },
        'workflow-b': { prod: { name: 'Order Processor' } },
      },
    };
    expect(() => validateNoCircularMapping(map, 'dev', 'prod')).not.toThrow();
  });
});
