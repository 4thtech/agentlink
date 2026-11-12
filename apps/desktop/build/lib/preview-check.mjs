// Release builds must not contain a code path that reads AGENTLINK_DESKTOP_PREVIEW.
export const PREVIEW_VAR = 'AGENTLINK_DESKTOP_PREVIEW';

/** files: [{path, content: Buffer}]. Returns the paths whose content mentions the variable. */
export function findPreviewString(files) {
  const needle = Buffer.from(PREVIEW_VAR);
  return files.filter((f) => Buffer.from(f.content).includes(needle)).map((f) => f.path);
}
