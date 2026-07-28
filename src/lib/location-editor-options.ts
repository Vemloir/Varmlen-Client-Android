import type { EditorChoice } from "./api";

/** Keep provider/core values editable even when they are newer than Varmlen's
 * backend catalogue. The current value is appended without silently changing
 * it or forcing an invalid default. */
export function includeCurrentOption(
  options: EditorChoice[],
  current: string,
): EditorChoice[] {
  if (!current || options.some((option) => option.value === current)) {
    return options;
  }
  return [...options, { value: current, label: current }];
}
