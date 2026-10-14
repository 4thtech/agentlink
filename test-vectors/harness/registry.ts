// Loads every committed vector file. Vite inlines the JSON at transform time, so the same code works
// in Node, in browsers and in workerd, and nothing here can write to the files.

export interface VectorCase {
  readonly id: string;
  readonly source: string;
  readonly input: unknown;
  readonly expected: unknown;
}

export interface VectorFile {
  readonly suite: string;
  readonly version: number;
  readonly generator: { readonly tool: string; readonly version: string; readonly script: string };
  readonly cases: readonly VectorCase[];
}

export interface LoadedVectorFile {
  /** Directory under test-vectors/ that holds the file; must equal `file.suite`. */
  readonly directory: string;
  readonly file: VectorFile;
}

const modules = import.meta.glob<VectorFile>('../*/vectors.json', {
  eager: true,
  import: 'default',
});

export const vectorFiles: readonly LoadedVectorFile[] = Object.entries(modules)
  .map(([path, file]) => ({ directory: path.split('/')[1] ?? '', file }))
  .sort((a, b) => a.directory.localeCompare(b.directory));
