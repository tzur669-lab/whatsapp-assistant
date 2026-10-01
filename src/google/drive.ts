/**
 * Google Drive file search (2026-10-01), through the `drive` grant with
 * `drive.metadata.readonly`: names, kinds and dates, never contents.
 */
import type { GoogleApi, GoogleResult } from './api.js';

const BASE = 'https://www.googleapis.com/drive/v3/files';
const MAX_FILES = 10;

export type DriveFile = { name: string; kind: DriveKind; modifiedAt: number; owner: string | null };

export const DRIVE_KINDS = ['any', 'document', 'spreadsheet', 'presentation', 'pdf', 'image', 'folder'] as const;
export type DriveKind = (typeof DRIVE_KINDS)[number] | 'other';

const MIME: Record<Exclude<DriveKind, 'any' | 'other'>, string> = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  pdf: 'application/pdf',
  image: 'image/',
  folder: 'application/vnd.google-apps.folder',
};

function kindOf(mime: string): DriveKind {
  for (const [kind, prefix] of Object.entries(MIME)) {
    if (mime === prefix || (prefix.endsWith('/') && mime.startsWith(prefix))) return kind as DriveKind;
  }
  if (mime.includes('word')) return 'document';
  if (mime.includes('sheet') || mime.includes('excel')) return 'spreadsheet';
  return 'other';
}

/** A value inside Drive's query language, with its quotes and escapes taken out. */
export function driveValue(text: string): string {
  return text.replace(/['\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Drive's query, built by code: name words, kind, recency; never the trash. */
export function buildDriveQuery(params: { words: string | null; kind: DriveKind | null; days: number | null; nowMs: number }): string {
  const parts = ['trashed = false'];
  const words = params.words ? driveValue(params.words) : '';
  if (words) parts.push(`name contains '${words}'`);
  if (params.kind && params.kind !== 'any' && params.kind !== 'other') {
    const mime = MIME[params.kind];
    parts.push(mime.endsWith('/') ? `mimeType contains '${mime}'` : `mimeType = '${mime}'`);
  }
  if (params.days) parts.push(`modifiedTime > '${new Date(params.nowMs - params.days * 86_400_000).toISOString()}'`);
  return parts.join(' and ');
}

export class DriveClient {
  constructor(private readonly api: GoogleApi) {}

  async search(query: string): Promise<GoogleResult<DriveFile[]>> {
    const url =
      `${BASE}?q=${encodeURIComponent(query)}&pageSize=${MAX_FILES}&orderBy=modifiedTime%20desc` +
      `&fields=${encodeURIComponent('files(name,mimeType,modifiedTime,owners(displayName))')}`;
    const result = await this.api.call(url);
    if (!result.ok) return result;
    const files = (result.value as { files?: unknown }).files;
    if (!Array.isArray(files)) return { ok: true, value: [] };
    const out: DriveFile[] = [];
    for (const file of files) {
      const record = file as { name?: unknown; mimeType?: unknown; modifiedTime?: unknown; owners?: unknown };
      if (typeof record.name !== 'string' || record.name.length === 0) continue;
      const modifiedAt = Date.parse(String(record.modifiedTime ?? ''));
      const owner = Array.isArray(record.owners) ? (record.owners[0] as { displayName?: unknown } | undefined)?.displayName : undefined;
      out.push({
        name: record.name.slice(0, 150),
        kind: kindOf(String(record.mimeType ?? '')),
        modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : 0,
        owner: typeof owner === 'string' ? owner.slice(0, 60) : null,
      });
    }
    return { ok: true, value: out };
  }
}
