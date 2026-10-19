import { parseProject, type Project } from '../../shared/model.ts';

// Save / open the project as JSON. Uses the File System Access API when the
// browser has it (Chrome, Edge) so ⌘S overwrites the same file; otherwise it
// falls back to a download and a file picker.

interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface FsWindow {
  showSaveFilePicker?: (o: unknown) => Promise<FileHandle>;
  showOpenFilePicker?: (o: unknown) => Promise<FileHandle[]>;
}
const fsWindow = window as unknown as FsWindow;
const TYPES = [{ description: 'Proyecto MyEditor', accept: { 'application/json': ['.json'] } }];

export const serialize = (p: Project) => JSON.stringify(p, null, 2);
export const fileNameFor = (p: Project) => `${p.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'proyecto'}.myeditor.json`;

export async function saveProject(p: Project, handle: FileHandle | null, saveAs: boolean): Promise<FileHandle | null> {
  const text = serialize(p);
  if (fsWindow.showSaveFilePicker) {
    try {
      const h = handle && !saveAs ? handle : await fsWindow.showSaveFilePicker({ suggestedName: fileNameFor(p), types: TYPES });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return h;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return handle;
      // Fall through to a plain download if the picker is blocked (e.g. embedded preview).
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(p);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}

export async function openProject(): Promise<{ project: Project; handle: FileHandle | null } | null> {
  if (fsWindow.showOpenFilePicker) {
    try {
      const [h] = await fsWindow.showOpenFilePicker({ types: TYPES, multiple: false });
      return { project: parseProject(JSON.parse(await (await h.getFile()).text())), handle: h };
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      if (err instanceof SyntaxError) throw new Error('El archivo no es JSON válido.');
      if ((err as Error).name !== 'SecurityError') throw err;
    }
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
  if (!file) return null;
  try {
    return { project: parseProject(JSON.parse(await file.text())), handle: null };
  } catch (err) {
    throw err instanceof SyntaxError ? new Error('El archivo no es JSON válido.') : err;
  }
}

export type { FileHandle };
