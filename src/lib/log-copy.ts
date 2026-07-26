export type LogCopyResult = "empty" | "copied" | "failed";

export async function copyDisplayedLog(
  text: string,
  writeText: (text: string) => Promise<void>,
): Promise<LogCopyResult> {
  if (text.length === 0) return "empty";

  try {
    await writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
