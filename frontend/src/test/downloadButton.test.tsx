import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

const fetched: [string, unknown, string][] = [];
const saved: string[] = [];
let fail = false;
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  fetchFile: async (path: string, query: unknown, name: string) => {
    fetched.push([path, query, name]);
    if (fail) throw new Error('Role not permitted');
    return { blob: new Blob(['x']), filename: 'server-name.csv' };
  },
  saveBlob: (_b: Blob, name: string) => { saved.push(name); },
}));

import { DownloadButton } from '../components/DownloadButton';

const renderBtn = () => render(
  <ToastProvider>
    <DownloadButton path="/audit/export.csv" query={{ action: 'billing.' }} filename="audit.csv">Export CSV</DownloadButton>
  </ToastProvider>,
);

describe('<DownloadButton>', () => {
  it('fetches with the query and saves under the server filename', async () => {
    renderBtn();
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(saved).toEqual(['server-name.csv']));
    expect(fetched[0]).toEqual(['/audit/export.csv', { action: 'billing.' }, 'audit.csv']);
  });

  it('shows an error toast and saves nothing when the download fails', async () => {
    fail = true;
    saved.length = 0;
    renderBtn();
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect((await screen.findAllByText(/role not permitted/i)).length).toBeGreaterThan(0);
    expect(saved).toEqual([]);
  });
});
