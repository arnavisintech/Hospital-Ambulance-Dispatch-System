import { useState } from 'react';
import { Download } from 'lucide-react';
import { fetchFile, saveBlob, type ReqOpts } from '../lib/api';
import { Button, useToast, type ButtonProps } from './ui';

interface Props extends Omit<ButtonProps, 'onClick' | 'loading'> {
  /** API path of a server-generated file, e.g. `/dashboard/report.csv`. */
  path: string;
  query?: ReqOpts['query'];
  /** Used when the server does not name the file. */
  filename: string;
}

/** Authenticated download of a server-generated file (CSV report / export) with loading and error states. */
export function DownloadButton({ path, query, filename, children, variant = 'secondary', icon = Download, ...rest }: Props) {
  const [busy, setBusy] = useState(false);
  const { error } = useToast();
  const run = async () => {
    setBusy(true);
    try {
      const f = await fetchFile(path, query, filename);
      saveBlob(f.blob, f.filename);
    } catch (e) {
      error(e, { title: "Couldn't download the file" });
    } finally {
      setBusy(false);
    }
  };
  return <Button {...rest} variant={variant} icon={icon} loading={busy} onClick={() => void run()}>{children}</Button>;
}
