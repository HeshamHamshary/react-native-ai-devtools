import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface Session {
  user: string | null;
  signIn: (name: string) => void;
  signOut: () => void;
}

const Ctx = createContext<Session>({ user: null, signIn: () => {}, signOut: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const value = useMemo(() => ({ user, signIn: setUser, signOut: () => setUser(null) }), [user]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
