import { useLayoutEffect, useRef, useSyncExternalStore, type FocusEvent, type RefObject } from 'react';

// These boundaries mirror team-workspace.css: the inspector covers the conversation
// below 900px and the entire project workspace below 620px.
const overlayQuery = '(max-width: 900px)';
const compactQuery = '(max-width: 620px)';
const viewportSnapshot = () => window.matchMedia(compactQuery).matches ? 'compact'
  : window.matchMedia(overlayQuery).matches ? 'overlay' : 'wide';
const subscribeViewport = (notify: () => void) => {
  const queries = [window.matchMedia(overlayQuery), window.matchMedia(compactQuery)];
  queries.forEach(query => query.addEventListener('change', notify));
  return () => queries.forEach(query => query.removeEventListener('change', notify));
};
const focusable = (element: HTMLElement | null): element is HTMLElement => Boolean(element?.isConnected
  && !element.closest('[inert], [hidden], [aria-hidden="true"]')
  && !element.matches(':disabled') && element.getClientRects().length && getComputedStyle(element).visibility === 'visible');

export function useInspectorOverlay({ workspace, inspector, projectId, shown, empty }: {
  workspace: RefObject<HTMLDivElement | null>; inspector: RefObject<HTMLElement | null>;
  projectId?: string; shown: boolean; empty: boolean;
}) {
  const viewport = useSyncExternalStore(subscribeViewport, viewportSnapshot, () => 'wide');
  const visible = shown && !(viewport !== 'wide' && empty);
  const coversConversation = visible && viewport !== 'wide';
  const coversIndex = coversConversation && viewport === 'compact';
  const restoreTo = useRef<{ projectId?: string; element: HTMLElement } | null>(null);
  const previous = useRef({ coversConversation: false, coversIndex: false, visible: false, projectId, inspector: null as HTMLElement | null });

  const rememberFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && !inspector.current?.contains(event.target)
      && !event.target.closest('[inert]')) restoreTo.current = { projectId, element: event.target };
  };

  useLayoutEffect(() => {
    const before = previous.current;
    const pane = inspector.current;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entered = coversConversation && (!before.coversConversation || projectId !== before.projectId
      || (coversIndex && !before.coversIndex));
    const closed = before.visible && !visible;
    previous.current = { coversConversation, coversIndex, visible, projectId, inspector: pane };
    // Other dialogs, including the image viewer, own focus while this workspace is inert.
    if (workspace.current?.closest('[inert]')) return;
    if (entered && pane && !pane.contains(active)) {
      if (active && workspace.current?.contains(active) && !before.inspector?.contains(active)) {
        restoreTo.current = { projectId, element: active };
      }
      // Preserve a foreground dialog's focus if a viewport change happens behind it.
      if (active && active !== document.body && !workspace.current?.contains(active)) return;
      const target = pane.querySelector<HTMLElement>('[aria-label="收起稿件面板"], [aria-label="收起上下文面板"]')
        || pane.querySelector<HTMLElement>('.team-inspector-nav button[aria-pressed="true"]');
      (focusable(target) ? target : pane).focus({ preventScroll: true });
    } else if (closed && (!active || active === document.body || before.inspector?.contains(active))) {
      const host = workspace.current;
      const frame = requestAnimationFrame(() => {
        if (!host?.isConnected || workspace.current !== host || host.closest('[inert]')) return;
        const current = document.activeElement;
        if (current && current !== document.body && !before.inspector?.contains(current)) return;
        if ([...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')].some(focusable)) return;
        const saved = restoreTo.current;
        const target = saved && saved.projectId === projectId && focusable(saved.element) ? saved.element
          : [...host.querySelectorAll<HTMLElement>('.team-reopen-inspector, [aria-label="告诉负责人新的要求"], [aria-label="搜索当前项目"]')].find(focusable) || null;
        if (focusable(target)) target.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [coversConversation, coversIndex, visible, projectId, workspace, inspector]);

  return { coversConversation, coversIndex, visible, rememberFocus };
}
