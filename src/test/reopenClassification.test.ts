import { describe, it, expect } from 'vitest';
import { resolveImportedClassification, isOpenStage, isClosedWonLostStage } from '@/lib/forecastClassification';

describe('resolveImportedClassification — reopen clears stale omitted', () => {
  it('clears omitted when a Closed Won deal reopens on an open stage', () => {
    // existing: omitted + Closed Won stage; incoming: back on an open stage → 'commit'
    expect(resolveImportedClassification('omitted', 'commit', 'Closed Won', 'Negotiation')).toBe('commit');
  });

  it('clears omitted when a Closed Lost deal reopens, recomputing to incoming (unclassified)', () => {
    expect(resolveImportedClassification('omitted', 'unclassified', 'Closed Lost', 'Discovery')).toBe('unclassified');
  });

  it('keeps omitted sticky when the stage stays closed (no reopen)', () => {
    expect(resolveImportedClassification('omitted', 'commit', 'Closed Won', 'Closed Won')).toBe('omitted');
  });

  it('keeps omitted sticky when there is no stage evidence', () => {
    expect(resolveImportedClassification('omitted', 'commit')).toBe('omitted');
  });

  it('does not treat a blank incoming stage as a reopen', () => {
    expect(resolveImportedClassification('omitted', 'unclassified', 'Closed Won', '')).toBe('omitted');
  });

  it('does not reopen from a non-terminal existing stage', () => {
    // existing stage was already open — the omitted was a deliberate omit, keep it sticky
    expect(resolveImportedClassification('omitted', 'commit', 'Discovery', 'Negotiation')).toBe('omitted');
  });

  it('leaves non-omitted resolution unchanged (closed_won stays sticky)', () => {
    expect(resolveImportedClassification('closed_won', 'commit', 'Closed Won', 'Negotiation')).toBe('closed_won');
  });
});

describe('stage helpers', () => {
  it('isClosedWonLostStage matches Closed Won/Lost (normalized), not Rejected/open', () => {
    expect(isClosedWonLostStage('Closed Won')).toBe(true);
    expect(isClosedWonLostStage('closed-lost')).toBe(true);
    expect(isClosedWonLostStage('Rejected')).toBe(false);
    expect(isClosedWonLostStage('Discovery')).toBe(false);
    expect(isClosedWonLostStage('')).toBe(false);
  });

  it('isOpenStage excludes terminal and blank stages', () => {
    expect(isOpenStage('Discovery')).toBe(true);
    expect(isOpenStage('Closed Won')).toBe(false);
    expect(isOpenStage('Closed Lost')).toBe(false);
    expect(isOpenStage('Rejected')).toBe(false);
    expect(isOpenStage('')).toBe(false);
    expect(isOpenStage(undefined)).toBe(false);
  });
});
