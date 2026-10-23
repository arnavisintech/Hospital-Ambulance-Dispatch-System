import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { ApiError } from '../lib/api';

let summary = { zones: 226, households: 2381538, population: 9270956, seniors: 1084702, source: 'synthetic' };
let uploadImpl: () => Promise<unknown> = async () => summary;
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async () => summary,
  api: async () => uploadImpl(),
}));

import { DemographicsCard } from '../pages/admin/shared/DemographicsCard';

const renderCard = () => render(<ToastProvider><DemographicsCard /></ToastProvider>);
const upload = (text: string) => {
  const input = screen.getByLabelText(/upload csv/i) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], 'wards.csv', { type: 'text/csv' })] } });
};

describe('<DemographicsCard>', () => {
  it('flags synthetic data and shows the totals', async () => {
    renderCard();
    expect(await screen.findByText(/synthetic estimate/i)).toBeInTheDocument();
    expect(screen.getByText('23,81,538')).toBeInTheDocument();   // en-IN grouping
  });

  it('lists every row error when the server rejects the file', async () => {
    uploadImpl = async () => { throw new ApiError(422, 'invalid', { errors: ['row 3: households must be a whole number >= 0', 'row 7: lat/lng must be numbers'] }); };
    renderCard();
    await screen.findByText(/synthetic estimate/i);
    upload('lat,lng\n');
    expect(await screen.findByText('row 3: households must be a whole number >= 0')).toBeInTheDocument();
    expect(screen.getByText('row 7: lat/lng must be numbers')).toBeInTheDocument();
  });

  it('shows imported data without the synthetic notice', async () => {
    summary = { ...summary, source: 'import' };
    uploadImpl = async () => summary;
    renderCard();
    expect(await screen.findByText(/imported data/i)).toBeInTheDocument();
    expect(screen.queryByText(/synthetic estimate/i)).toBeNull();
  });
});
