// What files the restaurant files screen (074) accepts, and how a search match is shown. Safe for the
// browser: no Node modules here (the text reading is in lib/file-text.ts, on the server).
export const FILE_TYPES: Record<string, {label: "PDF" | "DOC" | "XLS" | "IMG"; ext: string}> = {
  "application/pdf": {label: "PDF", ext: "pdf"},
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {label: "DOC", ext: "docx"},
  "application/msword": {label: "DOC", ext: "doc"},
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {label: "XLS", ext: "xlsx"},
  "application/vnd.ms-excel": {label: "XLS", ext: "xls"},
  "image/jpeg": {label: "IMG", ext: "jpg"}, "image/png": {label: "IMG", ext: "png"}, "image/webp": {label: "IMG", ext: "webp"}, "image/heic": {label: "IMG", ext: "heic"},
};
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT = 400_000;
export function checkFile(file: {type: string; size: number}): string | null {
  if (!FILE_TYPES[file.type]) return "Choose a PDF, Word, Excel or photo file.";
  if (!file.size) return "This file is empty. Choose another one.";
  if (file.size > MAX_FILE_BYTES) return "Choose a file smaller than 25 MB.";
  return null;
}


// "…[[yuzu]]…" from search_files becomes pieces to show, with the match marked.
export function snippetParts(snippet: string) {
  return snippet.split(/(\[\[.*?\]\])/).filter(Boolean).map(part => part.startsWith("[[") ? {hit: true, text: part.slice(2, -2)} : {hit: false, text: part});
}
