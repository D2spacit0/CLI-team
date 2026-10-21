import { useEffect, useState, useCallback, useRef } from 'react';

export type WorkbenchView =
  | 'rooms'
  | 'tasks'
  | 'members'
  | 'attention'
  | 'artifacts'
  | 'settings'
  | 'external'
  | 'archive'
  | 'fixtures';

export interface RouteState {
  view: WorkbenchView;
  roomId: string | null;
  taskId: string | null;
  panel: string | null;
}

interface NavigateOptions {
  roomId?: string | null;
  taskId?: string | null;
  panel?: string | null;
  replace?: boolean;
}

const decodeId = (value?: string): string | null => {
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
};

export function routeHash(view: WorkbenchView, options?: Omit<NavigateOptions, 'replace'>): string {
  let hash = `#/${view}`;
  if (view === 'rooms' && options?.roomId) {
    hash += `/${encodeURIComponent(options.roomId)}`;
  } else if (view === 'tasks' && options?.taskId) {
    hash += `/${encodeURIComponent(options.taskId)}`;
  }

  const queryParts: string[] = [];
  if (options?.taskId && view !== 'tasks') {
    queryParts.push(`task=${encodeURIComponent(options.taskId)}`);
  }
  if (options?.panel) {
    queryParts.push(`panel=${encodeURIComponent(options.panel)}`);
  }
  return queryParts.length > 0 ? hash + '?' + queryParts.join('&') : hash;
}

export function parseHash(hash: string, search = window.location.search): RouteState {
  const clean = hash.replace(/^#\/?/, '');
  if (!clean) {
    const searchRoom = new URLSearchParams(search).get('room');
    return { view: 'rooms', roomId: searchRoom, taskId: null, panel: null };
  }

  const [path, queryString] = clean.split('?');
  const params = new URLSearchParams(queryString || '');
  const segments = path.split('/');
  const primary = segments[0] as WorkbenchView;

  const validViews: WorkbenchView[] = [
    'rooms',
    'tasks',
    'members',
    'attention',
    'artifacts',
    'settings',
    'external',
    'archive',
    'fixtures',
  ];
  const view: WorkbenchView = validViews.includes(primary) ? primary : 'rooms';

  let roomId: string | null = null;
  let taskId: string | null = params.get('task');

  if (view === 'rooms' && segments[1]) {
    roomId = decodeId(segments[1]);
  } else if (!roomId) {
    roomId = new URLSearchParams(search).get('room');
  }

  if (view === 'tasks' && segments[1]) {
    taskId = decodeId(segments[1]);
  }

  return {
    view,
    roomId,
    taskId,
    panel: params.get('panel'),
  };
}

export function useWorkbenchRoute(initialRoomId?: string | null) {
  const [route, setRoute] = useState<RouteState>(() => {
    const parsed = parseHash(window.location.hash);
    if (!parsed.roomId && initialRoomId) {
      return { ...parsed, roomId: initialRoomId };
    }
    return parsed;
  });
  const routeRef = useRef(route);
  routeRef.current = route;
  const lastHash = useRef<string | null>(null);

  useEffect(() => {
    const handleHistoryChange = () => {
      const next = parseHash(window.location.hash);
      lastHash.current = window.location.hash;
      routeRef.current = next;
      setRoute(next);
    };
    window.addEventListener('hashchange', handleHistoryChange);
    window.addEventListener('popstate', handleHistoryChange);
    return () => {
      window.removeEventListener('hashchange', handleHistoryChange);
      window.removeEventListener('popstate', handleHistoryChange);
    };
  }, []);

  const navigate = useCallback((view: WorkbenchView, options?: NavigateOptions) => {
    const nextRoute = { ...options };
    const newHash = routeHash(view, nextRoute);
    const url = new URL(window.location.href);
    if (nextRoute.roomId) {
      url.searchParams.set('room', nextRoute.roomId);
    }
    url.hash = newHash;
    const current = new URL(window.location.href);
    if (current.pathname + current.search + current.hash !== url.pathname + url.search + url.hash) {
      window.history[nextRoute.replace ? 'replaceState' : 'pushState'](null, '', url);
    }
    lastHash.current = url.hash;
    // Keep route state in the same render as the initiating selection. Waiting
    // for hashchange lets the previous route restore the previous selection.
    setRoute(parseHash(newHash));
  }, []);

  const closeTask = useCallback(() => {
    const url = new URL(window.location.href);
    const parsed = parseHash(url.hash, url.search);
    if (!parsed.taskId) return;
    const target = { ...parsed, taskId: null };
    const newHash = routeHash(target.view, {
      roomId: target.roomId,
      ...(target.panel ? { panel: target.panel } : {}),
    });
    url.hash = newHash;
    // Keep opening and closing as separate history entries. Closing the panel
    // should not overwrite its detail route, or Back lands on the entry before
    // it and cannot reopen the task.
    window.history.pushState(null, '', url);
    lastHash.current = url.hash;
    routeRef.current = target;
    setRoute(target);
  }, []);

  const openTask = useCallback((view: WorkbenchView, options: NavigateOptions & { taskId: string }) => {
    if (!options.taskId) return;
    const next = { ...options, roomId: options.roomId ?? routeRef.current.roomId };
    const newHash = routeHash(view, next);
    const url = new URL(window.location.href);
    if (next.roomId) {
      url.searchParams.set('room', next.roomId);
    }
    url.hash = newHash;
    // Keep the room as the previous history entry and the detail with room
    // context as the current one. A later refresh can replace that entry
    // without collapsing the user's back/forward path.
    const target = parseHash(newHash, url.search);
    window.history.pushState(null, '', url);
    lastHash.current = url.hash;
    routeRef.current = target;
    setRoute(routeRef.current);
  }, []);

  return { route, lastHash, navigate, closeTask, openTask };
}
