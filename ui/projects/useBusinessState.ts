import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { BusinessSnapshot } from '../types';
import { emptyBusinessState, normalizeBusinessState } from './businessState';

export function useBusinessState(workspace: string | undefined) {
  const [data, setData] = useState<BusinessSnapshot>(emptyBusinessState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!workspace) return;
    const current = ++sequence.current;
    try {
      const next = await api.getBusinessState();
      if (sequence.current !== current) return;
      setData(normalizeBusinessState(next));
      setError('');
      setRevision((value) => value + 1);
    } catch (reason) {
      if (sequence.current === current) setError(reason instanceof Error ? reason.message : '业务数据读取失败');
    } finally { if (sequence.current === current) setLoading(false); }
  }, [workspace]);
  useEffect(() => {
    sequence.current++;
    setData(emptyBusinessState());
    setLoading(true);
    setError('');
    void refresh();
    return () => { sequence.current++; };
  }, [refresh]);
  return { data, loading, error, revision, refresh };
}
