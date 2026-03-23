import { useWorkspaceController } from './useWorkspaceController.ts'

export function usePublicWorkspaceController() {
  return useWorkspaceController('user')
}
