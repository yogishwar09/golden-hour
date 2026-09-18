/**
 * Session state: who is signed in, and the one shared socket connection that
 * belongs to them.
 *
 * The socket lives here rather than in a component because it must be created
 * exactly once per session and torn down on sign-out -- tying it to a screen
 * would reconnect on every navigation.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthResponse, LoginInput, RegisterInput, UserDto } from '@sas/shared';
import { api, getStoredToken, setUnauthorizedHandler, storeToken } from '../lib/api';
import { connectSocket, disconnectSocket, type AppSocket } from '../lib/socket';

interface AuthContextValue {
  user: UserDto | null;
  socket: AppSocket | null;
  /** True until the stored token has been checked, so routes do not flash. */
  initialising: boolean;
  signIn: (input: LoginInput) => Promise<UserDto>;
  signUp: (input: RegisterInput) => Promise<UserDto>;
  signOut: () => void;
  updateUser: (user: UserDto) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [initialising, setInitialising] = useState(true);
  // Guards against a stale async restore overwriting a newer sign-out.
  const generation = useRef(0);

  const openSocket = useCallback((token: string) => {
    setSocket(connectSocket(token));
  }, []);

  const signOut = useCallback(() => {
    generation.current += 1;
    storeToken(null);
    disconnectSocket();
    setSocket(null);
    setUser(null);
  }, []);

  // A 401 from any request means this session is over.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
  }, [signOut]);

  // Restore a stored session on first load.
  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setInitialising(false);
      return;
    }

    const attempt = ++generation.current;
    api
      .get<{ user: UserDto }>('/auth/me')
      .then((response) => {
        if (generation.current !== attempt) return;
        setUser(response.data.user);
        openSocket(token);
      })
      .catch(() => {
        // An expired or revoked token: start clean rather than half-signed-in.
        storeToken(null);
      })
      .finally(() => {
        if (generation.current === attempt) setInitialising(false);
      });
  }, [openSocket]);

  const adopt = useCallback(
    (payload: AuthResponse): UserDto => {
      generation.current += 1;
      storeToken(payload.accessToken);
      setUser(payload.user);
      openSocket(payload.accessToken);
      return payload.user;
    },
    [openSocket],
  );

  const signIn = useCallback(
    async (input: LoginInput) => adopt((await api.post<AuthResponse>('/auth/login', input)).data),
    [adopt],
  );

  const signUp = useCallback(
    async (input: RegisterInput) =>
      adopt((await api.post<AuthResponse>('/auth/register', input)).data),
    [adopt],
  );

  // Close the socket when the app unmounts, so a reload does not leave the
  // server holding a dead connection until its ping timeout.
  useEffect(() => () => disconnectSocket(), []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, socket, initialising, signIn, signUp, signOut, updateUser: setUser }),
    [user, socket, initialising, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
