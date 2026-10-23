import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmDialog } from '../../../components/ui';

/**
 * Unsaved-changes guard for BrowserRouter apps (no data-router `useBlocker`):
 *  - `beforeunload` prompt for reloads / tab close;
 *  - intercepts clicks on in-app links (sidebar, menus) while dirty and asks first.
 * Render the returned element once in the page.
 */
export function useUnsavedGuard(dirty: boolean, message = 'Your changes on this page will be lost.') {
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search + url.hash;
      if (to === window.location.pathname + window.location.search + window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(to);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  return (
    <ConfirmDialog
      open={pending !== null}
      onClose={() => setPending(null)}
      tone="danger"
      title="Discard unsaved changes?"
      description={message}
      confirmLabel="Discard and leave"
      cancelLabel="Keep editing"
      onConfirm={() => {
        const to = pending;
        dirtyRef.current = false;
        setPending(null);
        if (to) navigate(to);
      }}
    />
  );
}
