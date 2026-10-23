import { describe, expect, it } from 'vitest';
import {
  allowedClaimTransitions, canTransitionClaim, changedSettings, claimSteps, csvEscape, fmtDurShort, fmtMs, fmtPercent,
  isClaimPending, isClaimTerminal, parseFleetText, rangeLabel, rangeToDays, settingDef, toCsv, validateSetting, MAX_BULK,
} from '../pages/admin/shared/logic';

describe('range → days', () => {
  it('maps the segmented control keys to the summary `days` param', () => {
    expect(rangeToDays('24h')).toBe(1);
    expect(rangeToDays('7d')).toBe(7);
    expect(rangeToDays('30d')).toBe(30);
    expect(rangeToDays('bogus')).toBe(7);
    expect(rangeLabel('24h')).toBe('Last 24 hours');
    expect(rangeLabel('30d')).toBe('Last 30 days');
  });
});

describe('number formatting', () => {
  it('uses an explicit percent scale (no 0.8% → 80% guessing)', () => {
    expect(fmtPercent(0.8, 'pct')).toBe('0.8%');
    expect(fmtPercent(0.8, 'ratio')).toBe('80.0%');
    expect(fmtPercent(null, 'pct')).toBe('--');
  });
  it('formats ms and short durations', () => {
    expect(fmtMs(540.4)).toBe('540 ms');
    expect(fmtMs(1234)).toBe('1.23 s');
    expect(fmtMs(undefined)).toBe('--');
    expect(fmtDurShort(460)).toBe('7m 40s');
    expect(fmtDurShort(45)).toBe('45s');
    expect(fmtDurShort(3840)).toBe('1h 4m');
    expect(fmtDurShort(null)).toBe('--');
  });
});

describe('CSV export', () => {
  it('escapes quotes, commas and newlines per RFC 4180', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(42)).toBe('42');
  });
  it('neutralises spreadsheet formula injection in text but not numbers', () => {
    expect(csvEscape('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvEscape('@cmd')).toBe("'@cmd");
    expect(csvEscape(-5)).toBe('-5');
  });
  it('builds a header + rows document with CRLF line endings', () => {
    const csv = toCsv([{ n: 'Adyar, South', u: 42.5 }, { n: 'Anna Nagar', u: 0 }], [
      { header: 'Station', value: (r) => r.n },
      { header: 'Utilisation %', value: (r) => r.u },
    ]);
    expect(csv).toBe('Station,Utilisation %\r\n"Adyar, South",42.5\r\nAnna Nagar,0\r\n');
  });
});

describe('bulk fleet parsing', () => {
  it('parses comma, tab and semicolon rows with defaults and normalisation', () => {
    const r = parseFleetText('tn 01  ab 1234\nTN-09-CD-5678\tALS\tno\nTN09EF9999;bls;yes');
    expect(r.rows).toHaveLength(3);
    expect(r.invalidCount).toBe(0);
    expect(r.rows[0]).toMatchObject({ line: 1, registration_number: 'TN 01 AB 1234', kind: 'BLS', staffed: true });
    expect(r.rows[1]).toMatchObject({ registration_number: 'TN-09-CD-5678', kind: 'ALS', staffed: false });
    expect(r.rows[2]).toMatchObject({ kind: 'BLS', staffed: true });
  });

  it('skips blanks, comments and a header row; keeps source line numbers', () => {
    const r = parseFleetText('registration,kind,staffed\n\n# south zone\nTN01AB1234,ALS');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].line).toBe(4);
  });

  it('flags invalid registration, type, staffed and extra columns', () => {
    const r = parseFleetText('AB\nTN01AB1234,XLS\nTN01AB1235,BLS,maybe\nTN01AB1236,BLS,yes,extra');
    expect(r.invalidCount).toBe(4);
    expect(r.rows[0].errors[0]).toMatch(/5–32/);
    expect(r.rows[1].errors[0]).toMatch(/BLS or ALS/);
    expect(r.rows[2].errors[0]).toMatch(/yes or no/);
    expect(r.rows[3].errors[0]).toMatch(/Too many columns/);
  });

  it('detects duplicates within the paste and against the existing fleet', () => {
    const r = parseFleetText('TN01AB1234\ntn 01ab1234\nTN 01AB1234\nTN09ZZ0001', ['tn09zz0001']);
    // "tn 01ab1234" normalises to "TN 01AB1234" which differs from "TN01AB1234"; the third line duplicates the second.
    expect(r.rows[0].errors).toEqual([]);
    expect(r.rows[1].errors).toEqual([]);
    expect(r.rows[2].errors).toEqual(['Duplicate of line 2']);
    expect(r.rows[3].errors).toEqual(['Already registered']);
    expect(r.valid.map((x) => x.line)).toEqual([1, 2]);
  });

  it('rejects batches above the server limit', () => {
    const text = Array.from({ length: MAX_BULK + 1 }, (_, i) => `TN01AB${String(i).padStart(4, '0')}`).join('\n');
    const r = parseFleetText(text);
    expect(r.errors[0]).toMatch(/At most 200/);
  });
});

describe('insurance claim transitions', () => {
  it('only allows the server state machine', () => {
    expect(allowedClaimTransitions('submitted')).toEqual(['under_review', 'rejected']);
    expect(allowedClaimTransitions('under_review')).toEqual(['approved', 'rejected']);
    expect(allowedClaimTransitions('approved')).toEqual(['settled']);
    expect(allowedClaimTransitions('rejected')).toEqual([]);
    expect(allowedClaimTransitions('settled')).toEqual([]);
    expect(allowedClaimTransitions(null)).toEqual([]);
    expect(canTransitionClaim('submitted', 'approved')).toBe(false);
    expect(canTransitionClaim('approved', 'settled')).toBe(true);
    expect(canTransitionClaim('settled', 'approved')).toBe(false);
  });
  it('classifies pending and terminal claims', () => {
    expect(isClaimPending('submitted')).toBe(true);
    expect(isClaimPending('under_review')).toBe(true);
    expect(isClaimPending('approved')).toBe(false);
    expect(isClaimTerminal('settled')).toBe(true);
    expect(isClaimTerminal('rejected')).toBe(true);
    expect(isClaimTerminal('approved')).toBe(false);
    expect(isClaimTerminal('unknown')).toBe(false);
  });
  it('derives timeline step states', () => {
    expect(claimSteps('under_review').map((s) => s.state)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    expect(claimSteps('settled').map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(claimSteps('rejected')).toEqual([{ key: 'submitted', state: 'done' }, { key: 'rejected', state: 'rejected' }]);
  });
});

describe('settings validation', () => {
  it('enforces numbers, integers and server ranges', () => {
    const share = settingDef('revenue_share_pct');
    expect(validateSetting(share, '70')).toBeNull();
    expect(validateSetting(share, '70.5')).toBeNull();
    expect(validateSetting(share, '')).toBe('Required');
    expect(validateSetting(share, 'abc')).toBe('Enter a number');
    expect(validateSetting(share, '101')).toBe('Must be between 0 and 100');
    const ack = settingDef('crew_ack_timeout_s');
    expect(validateSetting(ack, '30.5')).toBe('Enter a whole number');
    expect(validateSetting(ack, '4')).toBe('Must be between 5 and 600');
  });
  it('falls back to a generic definition for unknown keys', () => {
    const d = settingDef('new_thing_s');
    expect(d.label).toBe('New thing s');
    expect(validateSetting(d, '-3')).toBeNull();
  });
  it('detects changed keys numerically', () => {
    expect(changedSettings({ a: 70, b: 8 }, { a: '70.0', b: '9' })).toEqual(['b']);
    expect(changedSettings({ a: 70 }, { a: '' })).toEqual(['a']);
  });
});

describe('rupees and chart ticks', () => {
  it('formats rupees with consistent paise', async () => {
    const { fmtRupees } = await import('../pages/admin/shared/logic');
    expect(fmtRupees(1025)).toBe('₹1,025');
    expect(fmtRupees(612.5)).toBe('₹612.50');
    expect(fmtRupees(19492.5, true)).toBe('₹19,493');
    expect(fmtRupees(125000)).toBe('₹1,25,000');
    expect(fmtRupees(undefined)).toBe('--');
  });
  it('builds clean minute ticks for the response trend axis', async () => {
    const { minuteTicks } = await import('../pages/admin/shared/logic');
    expect(minuteTicks(600)).toEqual([0, 120, 240, 360, 480, 600, 720]);
    expect(minuteTicks(45)).toEqual([0, 30, 60]);
    const t = minuteTicks(5000);
    expect(t.length).toBeLessThanOrEqual(7);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(5000);
  });
});
