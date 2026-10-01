/**
 * Google Tasks (2026-10-01): lists like "קניות", and the tasks on them. The
 * user's own lists, through the `tasks` grant. Ids stay here and in stored
 * inputs; the model only ever sees titles, rendered by code.
 *
 * Tasks has no time of day — a due date only (PLAN §2) — which is why timed
 * reminders stay reminders.
 */
import type { GoogleApi, GoogleResult } from './api.js';

const BASE = 'https://tasks.googleapis.com/tasks/v1';
const MAX_TASKS = 100;
const MAX_TITLE = 200;

export type TaskList = { id: string; title: string };
export type Task = { id: string; title: string; due: string | null };

const asString = (value: unknown, max: number) => (typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null);

export class TasksClient {
  constructor(private readonly api: GoogleApi) {}

  async lists(): Promise<GoogleResult<TaskList[]>> {
    const result = await this.api.call(`${BASE}/users/@me/lists?maxResults=100`);
    if (!result.ok) return result;
    const items = (result.value as { items?: unknown }).items;
    if (!Array.isArray(items)) return { ok: true, value: [] };
    const lists: TaskList[] = [];
    for (const item of items) {
      const record = item as Record<string, unknown>;
      const id = asString(record['id'], 200);
      const title = asString(record['title'], MAX_TITLE);
      if (id && title) lists.push({ id, title });
    }
    return { ok: true, value: lists };
  }

  async createList(title: string): Promise<GoogleResult<TaskList>> {
    const result = await this.api.call(`${BASE}/users/@me/lists`, {
      method: 'POST',
      body: JSON.stringify({ title: title.slice(0, MAX_TITLE) }),
    });
    if (!result.ok) return result;
    const record = result.value as Record<string, unknown>;
    const id = asString(record['id'], 200);
    return id ? { ok: true, value: { id, title: asString(record['title'], MAX_TITLE) ?? title } } : { ok: false, error: { code: 'invalid_response' } };
  }

  /** Open tasks only: what is still to do. */
  async openTasks(listId: string): Promise<GoogleResult<Task[]>> {
    const result = await this.api.call(
      `${BASE}/lists/${encodeURIComponent(listId)}/tasks?showCompleted=false&showHidden=false&maxResults=${MAX_TASKS}`,
    );
    if (!result.ok) return result;
    const items = (result.value as { items?: unknown }).items;
    if (!Array.isArray(items)) return { ok: true, value: [] };
    const tasks: Task[] = [];
    for (const item of items) {
      const record = item as Record<string, unknown>;
      const id = asString(record['id'], 200);
      const title = asString(record['title'], MAX_TITLE);
      if (!id || !title || record['status'] === 'completed' || record['deleted'] === true) continue;
      tasks.push({ id, title, due: asString(record['due'], 40) });
    }
    return { ok: true, value: tasks };
  }

  async add(listId: string, title: string, dueDate: string | null): Promise<GoogleResult<Task>> {
    const result = await this.api.call(`${BASE}/lists/${encodeURIComponent(listId)}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: title.slice(0, MAX_TITLE), ...(dueDate ? { due: `${dueDate}T00:00:00.000Z` } : {}) }),
    });
    if (!result.ok) return result;
    const id = asString((result.value as Record<string, unknown>)['id'], 200);
    return id ? { ok: true, value: { id, title, due: dueDate } } : { ok: false, error: { code: 'invalid_response' } };
  }

  /** Mark done, or (`done: false`) open again — the undo of marking done. */
  async setDone(listId: string, taskId: string, done: boolean): Promise<GoogleResult<true>> {
    const result = await this.api.call(`${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify(done ? { status: 'completed' } : { status: 'needsAction', completed: null }),
    });
    return result.ok ? { ok: true, value: true } : result;
  }

  /** The undo of an add. A task already gone is the state the user asked for. */
  async remove(listId: string, taskId: string): Promise<GoogleResult<true>> {
    const result = await this.api.call(`${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    });
    if (!result.ok && result.error.code === 'not_found') return { ok: true, value: true };
    return result.ok ? { ok: true, value: true } : result;
  }
}
