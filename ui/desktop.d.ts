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
      requestPublicationApproval(contentId: string, versionId: string, expectedDigest: string):
        Promise<{ cancelled?: boolean; approval?: import('./types').PublicationApproval; id?: string; status?: string }>;
      openPublicationLogin(projectId?: string): Promise<import('./types').BusinessConnection>;
    };
  }
}
