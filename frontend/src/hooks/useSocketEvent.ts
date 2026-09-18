import { useEffect, useRef } from 'react';
import type { ServerToClientEvents } from '@sas/shared';
import { useAuth } from '../context/AuthContext';

/**
 * Subscribes to one server event for the lifetime of a component.
 *
 * The handler is held in a ref so that an inline arrow function -- which is a
 * new value on every render -- does not detach and re-attach the listener each
 * time the component re-renders.
 */
export function useSocketEvent<Event extends keyof ServerToClientEvents>(
  event: Event,
  handler: ServerToClientEvents[Event],
): void {
  const { socket } = useAuth();
  const saved = useRef(handler);
  saved.current = handler;

  useEffect(() => {
    if (!socket) return;

    const listener = (...args: unknown[]): void => {
      (saved.current as (...params: unknown[]) => void)(...args);
    };

    socket.on(event, listener as never);
    return () => {
      socket.off(event, listener as never);
    };
  }, [socket, event]);
}
