import { openUrl } from "./ipc";
import { normalizePreviewInput } from "./previewUrl";
import { useWorkspacesStore } from "../stores/workspaces";

/** Localhost links stay inside the owning task/workspace preview; all other
 * supported links use the backend's scheme-whitelisted external opener. */
export function openTerminalLink(workspacePath: string, value: string): void {
  const preview = normalizePreviewInput(value);
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((item) => item.path === workspacePath);
  if (preview && workspace) {
    useWorkspacesStore.getState().setActive(workspace.path);
    workspace.editor.getState().openPreview(preview);
    return;
  }
  void openUrl(value).catch(() => {});
}
