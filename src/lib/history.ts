import { useCallback, useReducer } from 'react';
import type { Project } from '../../shared/model.ts';

// Undo/redo over immutable projects. During a drag the UI calls `preview`
// (no history entry) and `commit` once at the end with the pre-drag snapshot.

interface State {
  past: Project[];
  present: Project;
  future: Project[];
  /** Bumped on every change; used to detect unsaved work. */
  revision: number;
}

type Action =
  | { type: 'apply'; project: Project; base?: Project }
  | { type: 'update'; fn: (p: Project) => Project }
  | { type: 'preview'; project: Project }
  | { type: 'reset'; project: Project }
  | { type: 'undo' }
  | { type: 'redo' };

const LIMIT = 200;

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'apply': {
      const base = a.base ?? s.present;
      if (a.project === base) return a.base ? { ...s, present: base } : s;
      return { past: [...s.past, base].slice(-LIMIT), present: a.project, future: [], revision: s.revision + 1 };
    }
    case 'update': {
      const next = a.fn(s.present);
      return next === s.present ? s : reducer(s, { type: 'apply', project: next });
    }
    case 'preview':
      return { ...s, present: a.project };
    case 'reset':
      return { past: [], present: a.project, future: [], revision: s.revision + 1 };
    case 'undo':
      if (!s.past.length) return s;
      return { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future], revision: s.revision + 1 };
    case 'redo':
      if (!s.future.length) return s;
      return { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1), revision: s.revision + 1 };
  }
}

export function useProjectHistory(initial: () => Project) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({ past: [], present: initial(), future: [], revision: 0 }));
  return {
    project: state.present,
    revision: state.revision,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    /** Apply an edit as one undo step. Pass `base` to commit a drag that started at `base`. */
    apply: useCallback((project: Project, base?: Project) => dispatch({ type: 'apply', project, base }), []),
    /** Apply an edit computed from the latest project (safe across awaits). */
    update: useCallback((fn: (p: Project) => Project) => dispatch({ type: 'update', fn }), []),
    preview: useCallback((project: Project) => dispatch({ type: 'preview', project }), []),
    reset: useCallback((project: Project) => dispatch({ type: 'reset', project }), []),
    undo: useCallback(() => dispatch({ type: 'undo' }), []),
    redo: useCallback(() => dispatch({ type: 'redo' }), []),
  };
}
