/**
 * Trims empty lines from the start and end of a string.
 * Any empty lines in the middle are preserved.
 */
export function trimEmptyLines(str: string): string {
  const lines = str.split('\n');

  while (lines.length > 0 && !lines[0]?.trim()) {
    lines.shift();
  }

  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) {
    lines.pop();
  }

  return lines.join('\n');
}

export function trimmed(strings: TemplateStringsArray, ...values: any[]) {
  const string = strings.reduce((result, str, i) => {
    return result + str + (values[i] || '');
  }, '');
  return trimEmptyLines(string);
}
