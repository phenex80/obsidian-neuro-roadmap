/** Returns a task line with only its Markdown checkbox marker changed. */
export function replaceTaskCheckbox(line: string, completed: boolean): string {
  return line.replace(
    /^(\s*[-*+]\s+)\[[^\]]\]/u,
    `$1[${completed ? 'x' : ' '}]`,
  );
}
