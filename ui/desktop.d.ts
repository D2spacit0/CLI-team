export interface DesktopInfo {
  version: string;
  workspace: string;
  platform: string;
}

declare global {
  interface Window {
    cliTeamDesktop?: {
      getInfo(): Promise<DesktopInfo>;
      selectWorkspace(): Promise<{ changed: boolean; workspace: string }>;
      openWorkspace(): Promise<void>;
      onBeforeLeave(save: () => Promise<boolean>, resume: () => void): () => void;
    };
  }
}
