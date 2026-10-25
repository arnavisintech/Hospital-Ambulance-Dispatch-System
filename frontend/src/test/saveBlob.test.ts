import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBlob } from '../lib/api';

describe('saveBlob (final review minor)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('keeps the object URL alive long enough for slow browsers to start the download', () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    saveBlob(new Blob(['a']), 'a.txt');
    vi.advanceTimersByTime(5000);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30000);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });
});
