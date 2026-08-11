export function cleanExtractedText(text: string, filename?: string): string {
  if (!text || text.trim().length < 10) {
    return '';
  }
  return text
    .replace(/\0/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
