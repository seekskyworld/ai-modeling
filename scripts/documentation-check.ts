/** Offline documentation checks shared by the source and package inventories. */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface DocumentationResult {
  documents: number;
  links: number;
  jsonExamples: number;
  errors: string[];
}

export async function documentationFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((e) => e.name);
  for (const directory of ['docs', 'examples', 'skills', '.github']) {
    if (entries.some((entry) => entry.name === directory && entry.isDirectory()))
      result.push(...(await markdownTree(root, directory)));
  }
  return result.sort();
}

async function markdownTree(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownTree(root, name)));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(name);
  }
  return result;
}

function prose(file: string, content: string, result: DocumentationResult): string {
  const lines = content.split('\n');
  let fence = '',
    language = '',
    start = 0;
  const code: string[] = [];
  return lines
    .map((line, index) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!fence && marker) {
        fence = marker[1]!;
        language = marker[2]!.trim();
        start = index + 1;
        code.length = 0;
        if (index === lines.length - 1) result.errors.push(`${file}:${start}: unclosed code fence`);
        return '';
      }
      if (!fence) return line;
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) {
        if (language === 'json') {
          result.jsonExamples++;
          try {
            JSON.parse(code.join('\n'));
          } catch {
            result.errors.push(`${file}:${start}: invalid JSON example`);
          }
        }
        fence = '';
      } else code.push(line);
      if (index === lines.length - 1 && fence) result.errors.push(`${file}:${start}: unclosed code fence`);
      return '';
    })
    .join('\n');
}

function headings(content: string): Set<string> {
  const result = new Set<string>();
  for (const match of content.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]!
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let slug = base,
      suffix = 0;
    while (result.has(slug)) slug = `${base}-${++suffix}`;
    result.add(slug);
  }
  for (const match of content.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]!);
  return result;
}

function targets(content: string): string[] {
  const inline = [...content.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\s*\)/g)];
  const references = [...content.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)];
  return [...inline, ...references].map((match) => match[1]!.replace(/^<|>$/g, ''));
}

function localTarget(file: string, target: string): { file: string; anchor: string } | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return;
  if (target.startsWith('/')) throw new Error('absolute file link; use a repository-relative path');
  const hash = target.indexOf('#');
  const location = decodeURIComponent((hash < 0 ? target : target.slice(0, hash)).split('?')[0]!);
  const anchor = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
  const destination = location
    ? path.posix.normalize(path.posix.join(path.posix.dirname(file), location))
    : file;
  if (destination === '..' || destination.startsWith('../')) throw new Error('link escapes the repository');
  return { file: destination, anchor };
}

export async function checkDocumentation(root: string, files: string[]): Promise<DocumentationResult> {
  const result: DocumentationResult = { documents: 0, links: 0, jsonExamples: 0, errors: [] };
  const documents = new Map<string, string>();
  const inventory = new Set(files);
  for (const file of files.filter((name) => /^examples\/.*\.json$/.test(name))) {
    result.jsonExamples++;
    try {
      JSON.parse(await readFile(path.join(root, file), 'utf8'));
    } catch {
      result.errors.push(`${file}: invalid JSON example`);
    }
  }
  for (const file of files.filter((name) => name.endsWith('.md'))) {
    documents.set(file, prose(file, await readFile(path.join(root, file), 'utf8'), result));
    result.documents++;
  }
  const anchors = new Map([...documents].map(([file, content]) => [file, headings(content)]));
  for (const [file, content] of documents) {
    for (const target of targets(content)) {
      try {
        const destination = localTarget(file, target);
        if (!destination) continue;
        result.links++;
        if (!inventory.has(destination.file)) throw new Error(`missing link target: ${destination.file}`);
        if (
          destination.anchor &&
          anchors.has(destination.file) &&
          !anchors.get(destination.file)!.has(destination.anchor)
        )
          throw new Error(`missing heading: ${destination.file}#${destination.anchor}`);
      } catch (error) {
        result.errors.push(`${file}: ${error instanceof Error ? error.message : 'invalid link'}`);
      }
    }
  }
  return result;
}

/** Source links may point to non-Markdown files; only existing in-tree files qualify. */
export async function sourceDocumentationInventory(root: string): Promise<string[]> {
  const files = await documentationFiles(root);
  const result = new Set(files);
  for (const file of files) {
    const scratch: DocumentationResult = { documents: 0, links: 0, jsonExamples: 0, errors: [] };
    for (const target of targets(prose(file, await readFile(path.join(root, file), 'utf8'), scratch))) {
      try {
        const destination = localTarget(file, target);
        if (destination) {
          await readFile(path.join(root, destination.file));
          result.add(destination.file);
        }
      } catch {
        // The common checker reports invalid or missing links with their source file.
      }
    }
  }
  return [...result].sort();
}
