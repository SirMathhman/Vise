import { err, ok, type Result } from "../../core/messages.ts";
import { childEnvironment } from "./child-env.ts";

// The Windows folder dialog, shown on the machine that runs Vise. The dialog needs a single-threaded apartment,
// hence -STA. It prints the folder the user chose, and nothing when they cancel.
const SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms; " +
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; " +
  "$dialog.ShowNewFolderButton = $true; " +
  "if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }";

// Opens the dialog and returns the folder chosen, or undefined when the user cancels.
export async function pickFolder(): Promise<Result<string | undefined>> {
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-Command", SCRIPT], {
    env: childEnvironment(process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return err(new Error("the folder dialog could not be opened"));
  const chosen = output.trim();
  return ok(chosen === "" ? undefined : chosen);
}
