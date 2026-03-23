import { useWorkspaceController } from './useWorkspaceController.ts'

export function useAdminWorkspaceController() {
  return useWorkspaceController('admin')
}
