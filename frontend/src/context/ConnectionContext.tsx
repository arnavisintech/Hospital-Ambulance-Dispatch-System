import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface ConnApi { socket: boolean | null; setSocket: (v: boolean | null) => void; online: boolean }
const Ctx = createContext<ConnApi>({ socket: null, setSocket: () => {}, online: true });

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<boolean | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const v = useMemo(() => ({ socket, setSocket, online }), [socket, online]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
export const useConnection = () => useContext(Ctx);

/** Pages with a live socket report its state so the shell indicator reflects it. */
export function useReportConnection(connected: boolean): void {
  const { setSocket } = useConnection();
  useEffect(() => {
    setSocket(connected);
    return () => setSocket(null);
  }, [connected, setSocket]);
}
