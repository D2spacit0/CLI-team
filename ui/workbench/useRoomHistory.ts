import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { emptyHistory, RoomHistoryCache } from './messageHistory';

const emptySnapshot = () => emptyHistory;
const noSubscription = () => () => {};
const noOperation = () => Promise.resolve();

export function useRoomHistory(workspace: string | undefined, roomId: string | null) {
  const [cache] = useState(() => new RoomHistoryCache(api.getRoomMessagePage));
  const entry = useMemo(() => workspace && roomId ? cache.get(workspace, roomId) : null, [cache, workspace, roomId]);
  const state = useSyncExternalStore(entry?.subscribe || noSubscription, entry?.getSnapshot || emptySnapshot);
  useEffect(() => { void entry?.refresh(); }, [entry]);
  const refresh = useCallback((target: string) => workspace ? cache.get(workspace, target).refresh() : Promise.resolve(), [cache, workspace]);
  return { ...state, refresh, loadOlder: entry?.loadOlder || noOperation };
}
