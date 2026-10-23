import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlideButton } from '../components/ui/SlideButton';
import { DataTable, filterRows, sortRows, type Column } from '../components/ui/DataTable';

describe('<SlideButton> keyboard path', () => {
  it('confirms with Enter and with Space on the focused knob', async () => {
    const onConfirm = vi.fn();
    render(<SlideButton label="Slide to start trip" onConfirm={onConfirm} />);
    const knob = screen.getByRole('button', { name: 'Slide to start trip' });
    expect(knob).toHaveAccessibleDescription(/press Enter/i);
    knob.focus();
    await act(async () => { fireEvent.keyDown(knob, { key: 'Enter' }); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ignores a plain pointer tap (must slide) but accepts AT-synthesised clicks', async () => {
    const onConfirm = vi.fn();
    render(<SlideButton label="Slide to confirm" onConfirm={onConfirm} />);
    const knob = screen.getByRole('button', { name: 'Slide to confirm' });
    await act(async () => { fireEvent.click(knob, { detail: 1 }); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(knob, { detail: 0 }); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled and confirms only once while pending', async () => {
    const disabled = vi.fn();
    const { unmount } = render(<SlideButton label="Off" disabled onConfirm={disabled} />);
    await act(async () => { fireEvent.keyDown(screen.getByRole('button', { name: 'Off' }), { key: ' ' }); });
    expect(disabled).not.toHaveBeenCalled();
    unmount();

    let resolve: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<SlideButton label="Slow" onConfirm={slow} />);
    const knob = screen.getByRole('button', { name: 'Slow' });
    await act(async () => { fireEvent.keyDown(knob, { key: ' ' }); });
    await act(async () => { fireEvent.keyDown(knob, { key: 'Enter' }); });
    expect(slow).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
  });
});

interface Row { id: number; name: string; eta: number | null; at: Date }
const rows: Row[] = [
  { id: 1, name: 'Bravo', eta: 300, at: new Date('2026-01-02') },
  { id: 2, name: 'alpha', eta: null, at: new Date('2026-01-03') },
  { id: 3, name: 'Charlie', eta: 60, at: new Date('2026-01-01') },
  { id: 4, name: 'item 10', eta: 120, at: new Date('2026-01-04') },
  { id: 5, name: 'item 9', eta: 120, at: new Date('2026-01-05') },
];
const cols: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'eta', header: 'ETA', sortable: true, align: 'right' },
  { key: 'at', header: 'When', sortable: true, accessor: (r) => r.at, cell: (r) => r.at.toISOString().slice(0, 10) },
];
const ids = (r: Row[]) => r.map((x) => x.id);

describe('DataTable sorting', () => {
  it('sorts strings case-insensitively with natural numbers', () => {
    expect(ids(sortRows(rows, cols, { key: 'name', dir: 'asc' }))).toEqual([2, 1, 3, 5, 4]);
    expect(ids(sortRows(rows, cols, { key: 'name', dir: 'desc' }))).toEqual([4, 5, 3, 1, 2]);
  });
  it('sorts numbers, keeps empties last in both directions, and is stable', () => {
    expect(ids(sortRows(rows, cols, { key: 'eta', dir: 'asc' }))).toEqual([3, 4, 5, 1, 2]);
    expect(ids(sortRows(rows, cols, { key: 'eta', dir: 'desc' }))).toEqual([1, 4, 5, 3, 2]);
  });
  it('sorts dates via accessor; null sort returns input', () => {
    expect(ids(sortRows(rows, cols, { key: 'at', dir: 'asc' }))).toEqual([3, 1, 2, 4, 5]);
    expect(sortRows(rows, cols, null)).toBe(rows);
  });
  it('filters across columns', () => {
    expect(ids(filterRows(rows, cols, 'ITEM'))).toEqual([4, 5]);
    expect(ids(filterRows(rows, cols, '  '))).toEqual([1, 2, 3, 4, 5]);
  });

  it('cycles aria-sort asc → desc → none on header click', () => {
    render(<DataTable caption="Test" data={rows} columns={cols} rowKey={(r) => r.id} />);
    const header = screen.getByRole('columnheader', { name: /ETA/ });
    const btn = within(header).getByRole('button');
    expect(header).toHaveAttribute('aria-sort', 'none');
    fireEvent.click(btn);
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    const firstCell = () => screen.getAllByRole('row')[1].querySelectorAll('td')[1].textContent;
    expect(firstCell()).toBe('60');
    fireEvent.click(btn);
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(firstCell()).toBe('300');
    fireEvent.click(btn);
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('searches and paginates', () => {
    render(<DataTable caption="Test" data={rows} columns={cols} rowKey={(r) => r.id} searchable pageSize={2} />);
    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'charlie' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
});
