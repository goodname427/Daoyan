export function treeFingerprint(workspaceRoot?: string): string;
export function fingerprintPaths(paths: string[], workspaceRoot?: string): string;
export function isValidationTreePath(path: string): boolean;
export function configFingerprint(workspaceRoot?: string): string;
export function recordFullGateEvidence(
  workspace: string,
  config: string,
  workspaceRoot?: string,
): string;
export function npmInvocation(environment?: NodeJS.ProcessEnv): {
  command: string;
  args: string[];
};
