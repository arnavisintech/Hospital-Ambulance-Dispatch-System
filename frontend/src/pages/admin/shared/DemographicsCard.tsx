import { useRef, useState } from 'react';
import { Download, Upload, Users } from 'lucide-react';
import { Button, Card, CardHeader, useToast } from '../../../components/ui';
import { useAsync } from '../../../hooks/useAsync';
import { ApiError, api, errMsg, get } from '../../../lib/api';
import { fmtNumber, fmtShare } from '../../../lib/format';

export interface DemographicsSummary {
  zones: number; households: number; population: number; seniors: number; source: 'synthetic' | 'import' | 'mixed' | null;
}

const TEMPLATE = 'lat,lng,households,pop_0_14,pop_15_59,pop_60_74,pop_75_plus\n13.0339,80.2676,5200,3900,13600,2300,800\n';

/** Residences and age groups per zone: the demand model's population inputs (seniors need more care). */
export function DemographicsCard() {
  const { success } = useToast();
  const s = useAsync(() => get<DemographicsSummary>('/admin/demographics/summary'), []);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErrors([]);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const out = await api<DemographicsSummary>('/admin/demographics/import', { method: 'POST', formData: fd });
      s.setData(out);
      success(`Imported ${fmtNumber(out.zones)} zones. Retrain the demand model to use them.`, { title: 'Demographics updated' });
    } catch (e) {
      const d = e instanceof ApiError ? (e.detail as { errors?: string[] } | undefined) : undefined;
      setErrors(d?.errors?.length ? d.errors : [errMsg(e)]);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const template = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hads-demographics-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const d = s.data;
  return (
    <Card as="section" aria-labelledby="demo-h">
      <CardHeader as="h2" icon={Users} title={<span id="demo-h">Population data</span>}
        subtitle="Households and age groups per zone. Areas with more older residents get more ambulance cover." />
      {d && (
        <dl className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-ink-500">Zones</dt><dd className="font-bold tabular-nums text-ink-900">{fmtNumber(d.zones)}</dd></div>
          <div><dt className="text-ink-500">Households</dt><dd className="font-bold tabular-nums text-ink-900">{fmtNumber(d.households)}</dd></div>
          <div><dt className="text-ink-500">Residents</dt><dd className="font-bold tabular-nums text-ink-900">{fmtNumber(d.population)}</dd></div>
          <div><dt className="text-ink-500">Aged 60+</dt><dd className="font-bold tabular-nums text-ink-900">{fmtShare(d.population ? d.seniors / d.population : null)}</dd></div>
        </dl>
      )}
      {d?.source === 'synthetic' && (
        <p className="mb-4 rounded-md bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
          This is a synthetic estimate for Chennai, not census data. Import ward-level figures to use real numbers.
        </p>
      )}
      {d?.source === 'import' && <p className="mb-4 text-sm text-ink-500">Using imported data.</p>}
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="demo-file">Upload CSV</label>
        <input id="demo-file" ref={input} type="file" accept=".csv,text/csv" className="sr-only"
          onChange={(e) => void upload(e.target.files?.[0])} />
        <Button icon={Upload} loading={busy} onClick={() => input.current?.click()}>Import CSV</Button>
        <Button variant="secondary" icon={Download} onClick={template}>Download template</Button>
      </div>
      {errors.length > 0 && (
        <div role="alert" className="mt-4 rounded-md bg-danger-bg px-3 py-2.5 text-sm text-danger-fg">
          <p className="font-semibold">Nothing was imported. Fix these rows and try again:</p>
          <ul className="mt-1 list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}
