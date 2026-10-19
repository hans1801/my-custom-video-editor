import { useSyncExternalStore } from 'react';
import type { Us } from '../../shared/model.ts';

// The playhead changes every frame while playing, so it lives outside React
// state: only the components that read it re-render.

type Listener = () => void;

export class PlayheadStore {
  private t: Us = 0;
  private listeners = new Set<Listener>();
  get = () => this.t;
  set = (t: Us) => {
    const next = Math.max(0, Math.round(t));
    if (next === this.t) return;
    this.t = next;
    this.listeners.forEach((l) => l());
  };
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
}

export const playhead = new PlayheadStore();

export function usePlayhead(): Us {
  return useSyncExternalStore(playhead.subscribe, playhead.get);
}
