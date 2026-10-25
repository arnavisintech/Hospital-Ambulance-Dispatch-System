import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { ApiError } from '../lib/api';

const posts: { client_uuid: string }[] = [];
let failNext = true;
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async () => [],
  post: async (_p: string, body: { client_uuid: string }) => {
    posts.push(body);
    if (failNext) { failNext = false; throw new ApiError(502, 'Bad gateway'); }   // committed, but the reply was lost
    return { id: 77, status: 'received' };
  },
}));
// The map reports its centre once, as the real map does when it settles.
vi.mock('../components/map', () => ({
  MapCanvas: ({ centerPin }: { centerPin?: { onChange: (p: [number, number]) => void } }) => {
    useEffect(() => { centerPin?.onChange([13.08, 80.27]); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-testid="map" />;
  },
}));

import { IvrModal } from '../pages/controller/IvrModal';

describe('<IvrModal>', () => {
  it('re-sends a failed call with the same client_uuid, so a retry can never dispatch twice', async () => {
    const created = vi.fn();
    render(<ToastProvider><IvrModal open onClose={() => undefined} onCreated={created} /></ToastProvider>);
    fireEvent.click(await screen.findByRole('radio', { name: /heart|cardiac/i }));
    const send = screen.getByRole('button', { name: /send|create|dispatch/i });
    fireEvent.click(send);
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(posts).toHaveLength(2);
    expect(posts[1].client_uuid).toBe(posts[0].client_uuid);
  });
});
