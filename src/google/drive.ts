/**
 * Google Drive file search (2026-10-01), through the `drive` grant with
 * `drive.metadata.readonly`: names, kinds and dates, never contents.
 */
import { withSignal } from './api.js';
import type { GoogleCaller, GoogleResult } from './api.js';

const BASE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const ABOUT = 'https://www.googleapis.com/drive/v3/about';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_DOC = 'application/vnd.google-apps.document';

/** A Doc the bot created (block L, L6): its id and the link to open it. */
export type CreatedDoc = { id: string; link: string };
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
  private importMime: 'text/markdown' | 'text/plain' | null = null;

  constructor(private readonly api: GoogleCaller) {}

  /** This client, its requests cut when an agent turn's deadline fires (`api.ts`). */
  withSignal(signal: AbortSignal): DriveClient {
    return new DriveClient(withSignal(this.api, signal));
  }

  /** Whether the grant holds `scope` (block L, L6): false when it cannot tell. */
  hasScope(scope: string): boolean {
    return this.api.grantedScopes?.().includes(scope) ?? false;
  }

  /**
   * The source type a Google Doc is made from (block L, L6): Markdown when
   * this account's `about.importFormats` lists it for Docs, else plain text.
   * Read once per client; a failed read means plain text, which always converts.
   */
  async sourceMime(): Promise<'text/markdown' | 'text/plain'> {
    if (this.importMime) return this.importMime;
    const result = await this.api.call(`${ABOUT}?fields=importFormats`);
    const formats = result.ok ? (result.value as { importFormats?: Record<string, unknown> }).importFormats : undefined;
    const markdown = formats?.['text/markdown'];
    this.importMime = Array.isArray(markdown) && markdown.includes(GOOGLE_DOC) ? 'text/markdown' : 'text/plain';
    return this.importMime;
  }

  /**
   * A new Google Doc from text, one multipart upload, never retried by the
   * caller (not idempotent). `op` goes into `appProperties`, so an uncertain
   * outcome can be looked up (`findByOp`). Needs `drive.file`: the bot sees
   * only the files it made.
   */
  async createDoc(params: { title: string; body: string; op: string }): Promise<GoogleResult<CreatedDoc>> {
    const mime = await this.sourceMime();
    const boundary = `bot-${params.op}`;
    const metadata = JSON.stringify({ name: params.title, mimeType: GOOGLE_DOC, appProperties: { op: params.op } });
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      metadata,
      `--${boundary}`,
      `Content-Type: ${mime}; charset=UTF-8`,
      '',
      params.body,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const result = await this.api.call(`${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent('id,webViewLink')}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!result.ok) return result;
    return docOf(result.value);
  }

  /**
   * The Doc an earlier `createDoc` with this `op` made, if Google has it
   * listed (block L, L6). Not found is not proof it was never made: a new file
   * may not be listed yet — the caller says "unknown", never "failed".
   */
  async findByOp(op: string): Promise<GoogleResult<CreatedDoc | null>> {
    if (!/^[0-9a-f]{8,64}$/.test(op)) return { ok: false, error: { code: 'invalid_response' } };
    const query = `appProperties has { key='op' and value='${op}' } and trashed = false`;
    const result = await this.api.call(`${BASE}?q=${encodeURIComponent(query)}&pageSize=1&fields=${encodeURIComponent('files(id,webViewLink)')}`);
    if (!result.ok) return result;
    const files = (result.value as { files?: unknown }).files;
    if (!Array.isArray(files) || files.length === 0) return { ok: true, value: null };
    const doc = docOf(files[0]);
    return doc.ok ? doc : { ok: true, value: null };
  }

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

function docOf(raw: unknown): GoogleResult<CreatedDoc> {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as { id?: unknown; webViewLink?: unknown };
  if (typeof record.id !== 'string' || record.id.length === 0) return { ok: false, error: { code: 'invalid_response' } };
  const link =
    typeof record.webViewLink === 'string' && record.webViewLink.startsWith('https://docs.google.com/')
      ? record.webViewLink
      : `https://docs.google.com/document/d/${encodeURIComponent(record.id)}/edit`;
  return { ok: true, value: { id: record.id, link } };
}
