import { message } from "@tauri-apps/plugin-dialog";
import { checkpointAgentUserSubmit } from "../stores/agentTasks";

/** Shared raw-Enter checkpoint error handling for both terminal docks. */
export async function checkpointBeforeUserSubmit(terminalId: string): Promise<void> {
  try {
    await checkpointAgentUserSubmit(terminalId);
  } catch (error) {
    await message(
      `The prompt was not sent because Vibe Studio could not create its filesystem checkpoint.\n\n${String(error)}`,
      { title: "Checkpoint Failed", kind: "error" },
    );
    throw error;
  }
}
