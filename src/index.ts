#!/usr/bin/env node
/**
 * Studiolo MCP Server
 *
 * Read-only access to the local visual reference archive at Design Work/_inspo/, so an
 * assistant can search it and actually look at what is in it.
 *
 * Read-only on purpose. Writing labels was considered and dropped: in Claude Code the
 * filesystem is already reachable, so a write tool would duplicate something that already
 * works. The reason this server exists at all is the clients that have no filesystem —
 * Claude desktop, phone, anything else speaking MCP.
 *
 * It is a thin client of the canvas app itself on :4444, which already builds the joined index
 * (paths, _manifest.md labels and page clips, pixel dimensions, video duration) and already
 * generates thumbnails. Nothing is reimplemented here.
 *
 * That backend used to live inside the HQ dashboard, a login agent that is always up. It belongs
 * to the canvas now, and the canvas is started and stopped deliberately — so these tools only
 * work while it is running. That is the honest arrangement rather than a regression: looking at
 * the archive is what you would open the app for anyway. Every tool says so when it cannot reach
 * it.
 *
 * Optional environment:
 *   INSPO_CANVAS_URL — defaults to http://localhost:4444
 *                      (INSPO_HQ_URL is still read, for configs written before the split)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HQ = (process.env.INSPO_CANVAS_URL ?? process.env.INSPO_HQ_URL ?? 'http://localhost:4444').replace(/\/$/, '');
// See the note at the index read: this is how a client says the request is somebody's, not a page's.
const ASKED = { 'X-Studiolo': 'mcp' };

// Each returned image costs roughly 1-2k tokens, so viewing is bounded. Twelve is enough to
// compare a set; the whole archive would be 247 and is never the right answer.
const MAX_VIEW = 12;

type Root = {
  id: string;
  name: string;
  dir: string;
  writable: boolean;
  primary: boolean;
  count: number;
  missing: boolean;
};

type IndexFile = {
  path: string;
  root?: string;
  size: number;
  mtime: number;
  sig?: string;          // cache-buster: path, mtime and size — not a content hash
  w?: number;
  h?: number;
  kind?: string;
  duration?: number;
  link?: { title?: string; url?: string; note?: string; date?: string };
  label?: { screen?: string; note?: string };
};

/* Loaded once, at module scope, rather than inside the tool: the search language is not per-query
   and a dynamic import per call would re-resolve on every search. */
const { parseQuery, matchesQuery, normalize: normalizeQuery } = await import('../vendor/query.js');

/* Writing needs an Origin. `mayChangeState` refuses a POST that has none — `originAllowed('')`
   throws and is false — so a bare request from this process would be turned away. Naming the app's
   own origin is honest rather than a bypass: this is a local process talking to the app on
   loopback, exactly as `desktop/api.js` does for the menu bar. */
async function post(route: string, body: unknown): Promise<any> {
  const res = await fetch(`${HQ}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: HQ },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

/* Every file that any canvas is currently using.
 *
 * THE REASON THIS EXISTS is the one thing that makes a rename from here dangerous. When the app
 * renames a file it also rewrites every canvas element pointing at it — and it does that in the
 * BROWSER, against IndexedDB (`dbAll('elements')` in library.js). The server route only moves the
 * file. So a rename issued from here would move the bytes and leave every canvas element pointing
 * at nothing, manufacturing exactly the broken elements the app's own move exists to prevent.
 * Rather than half-do it, `rename_file` refuses for a file on a canvas and says where to do it
 * instead. Refusing is the direction everything else in this app leans. */
/* Thrown when the question "what is on a canvas?" has no answer, as opposed to the answer being
 * "nothing". The two were the same value here, and that was the defect. */
class CanvasStateUnknown extends Error {}

async function pathsOnCanvases(): Promise<Set<string>> {
  const used = new Set<string>();
  const res = await fetch(`${HQ}/api/canvases`);
  /* 404 is the one honest empty: no snapshot has ever been written, so there are no canvases and
   * nothing can be on one. Every other failure is an absence of information, and this used to
   * treat them all as the empty set — `if (!res.ok) return used`.
   *
   * WHAT THAT COST. The route answers 404 when `autosave.json` is missing OR unreadable, and
   * unreadable is a state this app manufactures for itself: `quarantine()` renames a corrupt
   * snapshot aside, after which the file is genuinely gone until the next write. So in exactly the
   * moment Studiolo has decided its own canvas record cannot be trusted — when `/api/canvas-autosave`
   * is refusing saves and tidy is refusing to sweep — this returned "nothing is on a canvas" and
   * the rename went through, leaving every element on three canvases pointing at nothing.
   *
   * The server distinguishes the two now (409 for unreadable), and this refuses on anything that is
   * not a 200 or that honest 404. The rule is the server's own, written at guards.js:366 and
   * enforced by `tidyDecision` against both MISSING and UNREADABLE: missing information is not
   * permission. It was re-decided here, in another language, and inverted.
   *
   * Worth keeping for the file it is not in yet: this is B1's shape. An entitlement check written
   * as `fetch(...)` → `!res.ok` → "not restricted" is the revoke-the-paying-customer bug, and
   * licensing has not been built. (Pre-ship audit 2026-08-17, P1-3.) */
  if (res.status === 404) return used;
  if (!res.ok) {
    throw new CanvasStateUnknown(`Studiolo answered ${res.status} for what is on its canvases`);
  }
  const list: any = await res.json();
  const canvases: any[] = list.canvases ?? [];
  /* A canvas is addressed by name, and the route resolves it with `find()` — so two canvases
   * sharing a name inside one project collapse to the first, and every element of the second is
   * invisible here. That is the same failure with no corruption required, so it is refused rather
   * than enumerated: there is no way to ask for the second one. */
  const seen = new Set<string>();
  for (const c of canvases) {
    /* A real NUL, written as an ESCAPE rather than typed. Typed literally it makes this whole
       file BINARY to grep, and `js/core.js` carries a paragraph about the day that happened
       there: every string sweep over the codebase silently skipped the module that every other
       module imports from, four audit lenses' sweeps included.
       It was reintroduced here on 2026-08-17 by the fix two comments above, and caught the same
       way it was caught the first time — a grep finding nothing in a file that plainly contains
       the word being searched for.
       NUL is the right separator and only the spelling was wrong: it cannot occur in a project
       or canvas name, so no two pairs of names can collide by concatenation. */
    const key = `${c.project ?? ''}\u0000${c.canvas ?? ''}`.toLowerCase();
    if (seen.has(key)) {
      throw new CanvasStateUnknown(
        `two canvases are called "${c.canvas}" in the same project, so what is on them cannot be read one by one`
      );
    }
    seen.add(key);
  }
  for (const c of canvases) {
    const qs = new URLSearchParams({ canvas: c.canvas, project: c.project });
    const r = await fetch(`${HQ}/api/canvases?${qs}`);
    // Was `continue`, which quietly dropped a whole canvas from the answer and left the caller
    // believing it had read everything.
    if (!r.ok) {
      throw new CanvasStateUnknown(`Studiolo answered ${r.status} for the canvas "${c.canvas}"`);
    }
    const j: any = await r.json();
    for (const it of j.items ?? []) if (it.path) used.add(it.path);
  }
  return used;
}

async function loadIndex(): Promise<IndexFile[]> {
  return (await loadArchive()).files;
}
async function loadArchive(): Promise<{ files: IndexFile[]; roots: Root[] }> {
  /* Marked as the app's own. Four routes start work — the enrichment pass, and here the archive
     walk itself — only for a caller that says it asked, because a page can pull them with an
     `<img src>`. An assistant searching the archive on somebody's behalf IS somebody asking, so
     the MCP claims it deliberately rather than inheriting it from a missing header.
     (Pre-ship audit 2026-08-20c, P2-2.) */
  const res = await fetch(`${HQ}/api/inspo-index`, { headers: ASKED });
  if (!res.ok) throw new Error(`Studiolo returned ${res.status}`);
  const json = (await res.json()) as { files?: IndexFile[]; roots?: Root[] };
  return { files: json.files ?? [], roots: json.roots ?? [] };
}

/* The library reads more than one folder, and a path names which: `@<rootId>/<path inside it>`.
   A folder filter is therefore root-scoped too — two roots can each hold a `packaging/`, and a
   tool that conflated them would return results the app itself would not. */
const ROOT_RE = /^@([A-Za-z0-9_-]+)\/(.*)$/;
const splitPath = (p: string) => {
  const m = p.match(ROOT_RE);
  return m ? { root: m[1], sub: m[2] } : { root: 'inspo', sub: p };
};
const rootOf = (p: string) => splitPath(p).root;
const subOf = (p: string) => splitPath(p).sub;
const topFolder = (p: string) => {
  const s = subOf(p);
  return s.includes('/') ? s.split('/')[0] : 'root';
};
// How a folder is named to a caller, and matched against what they pass back.
const folderKey = (p: string) => `@${rootOf(p)}/${topFolder(p)}`;
// A caller may pass either the full `@root/folder` key or just a folder name. The bare form
// matches that folder in any root, which is the forgiving reading and the one that was true
// before roots existed.
const folderMatches = (want: string, p: string) =>
  ROOT_RE.test(want) ? folderKey(p) === want : topFolder(p) === want;

// macOS screenshot filenames carry U+202F (narrow no-break space) before AM/PM. It survives a
// copy out of tool output, but it does not survive being retyped, and the two look identical.
// The same character silently broke 32 of 39 label matches once already, so a path that differs
// only in whitespace resolves rather than 404s.
const wsKey = (s: string) => s.replace(/[\s\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]+/g, ' ').trim();

function resolvePath(want: string, files: IndexFile[]): string | null {
  const clean = want.replace(/^\/+/, '');
  if (files.some((f) => f.path === clean)) return clean;
  const key = wsKey(clean).toLowerCase();
  const hit = files.find((f) => wsKey(f.path).toLowerCase() === key);
  return hit ? hit.path : null;
}
const isVideo = (f: IndexFile) => f.kind === 'video' || /\.(mp4|mov|m4v|webm)$/i.test(f.path);

// The same fields the app's own search reads, so results here match what the library shows.
/* The same fields the app searches, folded the same way.
 *
 * `.toLowerCase()` was not the same way, and that is a bug this project has already had once: the
 * app normalises — folding runs of punctuation to a single space — and `matchesQuery` is written
 * against a haystack in that form. Feeding it a raw one silently selects a code path no real caller
 * takes, which is exactly what `query.test.mjs`'s helper did before it was corrected.
 *
 * It showed up here as `"die cut"` matching nothing while the archive holds ten of them, because
 * they are written `die-cut` and only normalisation makes the hyphen a space. Found by running the
 * three example queries rather than by reading the diff. */
function haystack(f: IndexFile) {
  const L = f.link ?? {};
  const M = f.label ?? {};
  return normalizeQuery([f.path, L.title, L.url, L.note, M.screen, M.note]
    .filter(Boolean)
    .join(' '));
}

// One line per hit. Deliberately compact: a search can return thirty of these and the point is
// to choose what to look at, not to read prose about it.
function describe(f: IndexFile) {
  const bits: string[] = [f.path];
  const L = f.link, M = f.label;
  if (L?.title) bits.push(`title: ${L.title}`);
  if (L?.url) bits.push(`url: ${L.url}`);
  if (M?.screen) bits.push(`label: ${M.screen}`);
  const note = L?.note || M?.note;
  if (note) bits.push(`note: ${note}`);
  if (f.w && f.h) bits.push(`${f.w}x${f.h}`);
  if (isVideo(f)) bits.push(f.duration ? `video ${f.duration}s` : 'video');
  const saved = L?.date ?? new Date(f.mtime).toISOString().slice(0, 10);
  bits.push(`saved ${saved}`);
  return bits.join(' · ');
}

const server = new McpServer({
  name: 'studiolo',
  version: '1.0.0',
});

// ── Tool: search_inspo ────────────────────────────────────────────────────────

server.tool(
  'search_inspo',
  `Search the person's local visual reference archive by text.

Matches across the filename and folder, a saved page's title, URL and note, and the _manifest.md
label and note written for an image. Every space-separated
term must match, so "cosmos paywall" narrows rather than widens.

Returns metadata only — use view_inspo afterwards to actually look at the results. Prefer
searching before viewing: viewing is expensive and this is cheap.

Searches three ways at once, exactly as the app's own search box does, and says which is which:
an exact match on the words; then anything the phrase reaches BY MEANING; then, if the person has
switched it on, anything that looks right BY PICTURE — which is the only one that reaches an image
nobody has ever described.

Supports the app's full search language: "quoted phrases" hold words together, and -negation leaves
things out. Words match whole, so "red" does not match "centered".`,
  {
    query: z.string().describe('Words to look for. Space-separated terms are ANDed together.'),
    folder: z.string().optional().describe('Restrict to one folder, e.g. "riso" or "apps". Qualify it as "@<root>/<folder>" to mean one root\'s copy of a folder name; unqualified matches that folder in every root. Use list_folders to see them.'),
    kind: z.enum(['image', 'video', 'any']).optional().default('any').describe('Restrict by media type.'),
    limit: z.number().int().positive().max(100).optional().default(30).describe('Maximum results.'),
  },
  async ({ query, folder, kind, limit }) => {
    try {
      const files = await loadIndex();
      const scope = (f: IndexFile) => {
        if (folder && !folderMatches(folder, f.path)) return false;
        if (kind === 'video' && !isVideo(f)) return false;
        if (kind === 'image' && isVideo(f)) return false;
        return true;
      };

      /* THE SEARCH LANGUAGE IS THE APP'S, not a second one written here.
         This used to be `terms.every(t => hay.includes(t))` — a plain substring test, which is what
         the app itself did until the day it was measured and found to match inside words: `red`
         returned 86 items of which 57 were cente*red*, scatte*red*, laye*red*. The app fixed that,
         and gained quoted phrases and `-negation` at the same time, and this server kept the old
         behaviour because it had its own copy. One module now, so a search here means what a search
         in the window means. */
      const terms = parseQuery(query);
      const exact = files.filter((f) => scope(f) && (!terms.length || matchesQuery(haystack(f), terms)));
      const seen = new Set(exact.map((f) => f.path));

      /* AND THE OTHER TWO WAYS THE APP CAN LOOK, which this server could not.
         Search by meaning ranks the words written about an item; search by picture ranks the pixels,
         and is the only one that reaches an image nobody has described — which is precisely the
         limitation this tool's own description used to apologise for. Both are asked of the app
         rather than reimplemented, and both degrade to nothing: an unreachable route, a model that
         was never downloaded, or a gate that has not been opened simply contributes no extra rows. */
      const extra = async (route: string, group: string) => {
        try {
          const r = await fetch(`${HQ}${route}?q=${encodeURIComponent(query)}`, { headers: ASKED });
          if (!r.ok) return [] as Array<{ f: IndexFile; group: string }>;
          const j: any = await r.json();
          const byPath = new Map(files.map((f) => [f.path, f]));
          return ((j.results || []) as Array<{ path: string }>)
            .map((x) => byPath.get(x.path))
            .filter((f): f is IndexFile => !!f && scope(f) && !seen.has(f.path))
            .map((f) => { seen.add(f.path); return { f, group }; });
        } catch { return [] as Array<{ f: IndexFile; group: string }>; }
      };
      const byMeaning = query.length >= 2 ? await extra('/api/semantic', 'by meaning') : [];
      const byPicture = query.length >= 2 ? await extra('/api/picture-search', 'by picture') : [];

      const all = [
        ...exact.map((f) => ({ f, group: 'match' })),
        ...byMeaning,
        ...byPicture,
      ];
      if (!all.length) {
        return {
          content: [{
            type: 'text' as const,
            /* This used to end "…but only once it is switched on in Studiolo's settings", which was
               true until 2026-08-17 and then was not: both models ship inside the app and the flag
               was deleted rather than defaulted on. An assistant reading that would send somebody
               to a Settings row that does not exist, for a feature already running. */
            text: `Nothing for "${query}"${folder ? ` in ${folder}` : ''}. The archive is ${files.length} items. Searching by picture reaches images nobody has described, and it is always on. list_folders reports where descriptions are thin.`,
          }],
        };
      }
      const shown = all.slice(0, limit);
      /* The count says which are matches and which are guesses, because they are not the same claim.
         The app's own search line had to be corrected for exactly this: it read "60 matches for
         pegboard" when eight contained the word and fifty-two were inferred. */
      const guesses = all.length - exact.length;
      const head = `${exact.length} match${exact.length === 1 ? '' : 'es'} for "${query}"`
        + `${folder ? ` in ${folder}` : ''}`
        + (guesses ? `, and ${guesses} more by meaning or picture` : '')
        + (all.length > shown.length ? `, showing ${shown.length}` : '') + ':';
      return {
        content: [{ type: 'text' as const, text: [head, ...shown.map(({ f, group }) =>
          `- ${describe(f)}${group === 'match' ? '' : `  [${group}]`}`)].join('\n') }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Could not reach the archive: ${message}. Studiolo must be running on ${HQ}.` }],
        isError: true,
      };
    }
  }
);

// ── Tool: view_inspo ──────────────────────────────────────────────────────────

server.tool(
  'view_inspo',
  `Look at specific items from the archive. Takes paths from search_inspo or recent_inspo.

Returns the images themselves so they can actually be examined — composition, color, type,
layout. This is the tool that makes the archive useful rather than merely listed.

Images come back downscaled to roughly 640px on the long edge, which is enough to read a layout
and a palette. Ask for full resolution only when fine detail genuinely matters. Videos return
their poster frame, since a still is all that can be shown.

Costly: each image is roughly 1-2k tokens, and at most ${MAX_VIEW} are returned per call. Search
first and choose deliberately.`,
  {
    paths: z.array(z.string()).min(1).max(MAX_VIEW).describe(`Archive-relative paths, e.g. "riso/Riso (1).jpg". At most ${MAX_VIEW}.`),
    fullSize: z.boolean().optional().default(false).describe('Return the original instead of the downscaled version. Much more expensive; only for fine detail.'),
  },
  async ({ paths, fullSize }) => {
    const content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    > = [];
    let index: IndexFile[] = [];
    try { index = await loadIndex(); } catch { /* fall through; paths are then used verbatim */ }
    for (const given of paths) {
      const rel = (index.length ? resolvePath(given, index) : given) ?? given;
      if (index.length && !index.some((f) => f.path === rel)) {
        content.push({ type: 'text' as const, text: `${given} is not in the archive. Use search_inspo or recent_inspo to get exact paths.` });
        continue;
      }
      const encoded = rel.split('/').map(encodeURIComponent).join('/');
      const url = fullSize ? `${HQ}/inspo/${encoded}` : `${HQ}/thumb/${encoded}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          content.push({ type: 'text' as const, text: `${rel} could not load (${res.status})` });
          continue;
        }
        const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
        // A video's original is not an image; the thumbnail route already returns its poster.
        if (!mimeType.startsWith('image/')) {
          content.push({ type: 'text' as const, text: `${rel} is a video; call again without fullSize to get its poster frame.` });
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        content.push({ type: 'text' as const, text: rel });
        content.push({ type: 'image' as const, data: buf.toString('base64'), mimeType });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        content.push({ type: 'text' as const, text: `${rel} failed: ${message}` });
      }
    }
    if (!content.length) {
      return { content: [{ type: 'text' as const, text: 'Nothing could be loaded.' }], isError: true };
    }
    return { content };
  }
);

// ── Tool: list_folders ────────────────────────────────────────────────────────

server.tool(
  'list_folders',
  `List the folders the library reads, with their item counts and how many items in each carry a
written label.

The archive may span more than one root folder on disk — each is listed with its own folders
nested under it, and a folder is named "@<root>/<folder>" so the two can be told apart. Passing
just the folder name to search_inspo or recent_inspo matches that folder in any root.

The labeled count is the useful number: it says where the archive can be searched by meaning
and where it can only be searched by filename. A folder showing "0 labeled" holds material that
text search effectively cannot reach.`,
  {},
  async () => {
    try {
      const { files, roots } = await loadArchive();
      const byFolder = new Map<string, { total: number; labelled: number; video: number }>();
      for (const f of files) {
        const k = folderKey(f.path);
        const row = byFolder.get(k) ?? { total: 0, labelled: 0, video: 0 };
        row.total++;
        if (f.label?.screen || f.label?.note || f.link?.title) row.labelled++;
        if (isVideo(f)) row.video++;
        byFolder.set(k, row);
      }
      const line = (k: string, label: string) => {
        const r = byFolder.get(k)!;
        const extra = r.video ? `, ${r.video} video` : '';
        return `- ${label}: ${r.total} item${r.total === 1 ? '' : 's'}, ${r.labelled} labeled${extra}`;
      };
      const keysIn = (id: string) =>
        [...byFolder.keys()].filter((k) => rootOf(k) === id).sort((a, b) => subOf(a).localeCompare(subOf(b)));

      const out: string[] = [];
      // With one root there is nothing to disambiguate, so the listing stays flat — naming a root
      // that has no alternative is noise in every line of output.
      if (roots.length <= 1) {
        out.push(`${files.length} items across ${byFolder.size} folders:`);
        for (const k of keysIn(roots[0]?.id ?? 'inspo')) out.push(line(k, subOf(k)));
      } else {
        out.push(`${files.length} items across ${byFolder.size} folders in ${roots.length} root folders:`);
        for (const r of roots) {
          const flags = [r.primary ? 'primary' : '', r.writable ? '' : 'read-only', r.missing ? 'MISSING' : '']
            .filter(Boolean).join(', ');
          out.push('', `${r.name} (@${r.id})${flags ? ` — ${flags}` : ''} · ${r.dir}`);
          const keys = keysIn(r.id);
          if (!keys.length) out.push('- (nothing indexed)');
          for (const k of keys) out.push(line(k, k));
        }
      }
      return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Could not reach the archive: ${message}. Studiolo must be running on ${HQ}.` }],
        isError: true,
      };
    }
  }
);

// ── Tool: recent_inspo ────────────────────────────────────────────────────────

server.tool(
  'recent_inspo',
  `The most recently saved items, newest first.

Useful for "what did I collect this week", and for finding things clipped from the browser
extension that have not been sorted or described yet.`,
  {
    limit: z.number().int().positive().max(60).optional().default(20).describe('How many to return.'),
    folder: z.string().optional().describe('Restrict to one folder, optionally qualified as "@<root>/<folder>".'),
  },
  async ({ limit, folder }) => {
    try {
      const files = await loadIndex();
      const pool = folder ? files.filter((f) => folderMatches(folder, f.path)) : files;
      const recent = [...pool].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
      if (!recent.length) {
        return { content: [{ type: 'text' as const, text: folder ? `Nothing in ${folder}.` : 'The archive is empty.' }] };
      }
      return {
        content: [{
          type: 'text' as const,
          text: [`${recent.length} most recent${folder ? ` in ${folder}` : ''}:`, ...recent.map((f) => `- ${describe(f)}`)].join('\n'),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Could not reach the archive: ${message}. Studiolo must be running on ${HQ}.` }],
        isError: true,
      };
    }
  }
);

// ── Tool: list_canvases ───────────────────────────────────────────────────────

server.tool(
  'list_canvases',
  `List the canvases in the person's Studiolo projects, with how many items each holds.

A canvas is a *composition* — things they deliberately put next to each other — which is a
different thing from a folder, where items merely share a category. Reviewing a canvas is
therefore a much more pointed question than reviewing the archive.

Canvases live in the canvas app's browser storage and are mirrored to disk on every change, so
what is reported here is the state as of the last edit.`,
  {},
  async () => {
    try {
      const res = await fetch(`${HQ}/api/canvases`);
      const j = (await res.json()) as { canvases?: Array<{ project: string; canvas: string; items: number }>; savedAt?: string; error?: string };
      if (j.error) return { content: [{ type: 'text' as const, text: j.error }], isError: true };
      const rows = (j.canvases ?? []).map((c) => `- ${c.project} / ${c.canvas}: ${c.items} item${c.items === 1 ? '' : 's'}`);
      const head = j.savedAt ? `Canvases as of ${j.savedAt}:` : 'Canvases:';
      return { content: [{ type: 'text' as const, text: [head, ...rows].join('\n') }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Could not read the canvases: ${message}. Studiolo must be running on ${HQ}.` }], isError: true };
    }
  }
);

// ── Tool: canvas_items ────────────────────────────────────────────────────────

server.tool(
  'canvas_items',
  `What is on one canvas, in reading order, with each item's description.

Returns paths and metadata, not pictures — pass the paths to view_inspo to actually look at
the arrangement.

Order is spatial: top to bottom, then left to right within a row. That matters, because a canvas
is an arrangement and the order things were added in says nothing about how they now sit beside
each other. Text and sticky notes on the canvas are returned too, in position, since they are
often the reason a grouping exists.`,
  {
    canvas: z.string().describe('Canvas name, e.g. "Packaging". Case-insensitive. Use list_canvases to see them.'),
    project: z.string().optional().describe('Project name, if two canvases share a name.'),
  },
  async ({ canvas, project }) => {
    try {
      const qs = new URLSearchParams({ canvas });
      if (project) qs.set('project', project);
      const res = await fetch(`${HQ}/api/canvases?${qs}`);
      const j = (await res.json()) as {
        project?: string; canvas?: string; savedAt?: string; error?: string;
        canvases?: string[];
        items?: Array<{ type: string; path: string | null; text: string | null; x: number; y: number; w: number; h: number }>;
      };
      if (j.error) {
        const known = j.canvases?.length ? `\nCanvases: ${j.canvases.join(', ')}` : '';
        return { content: [{ type: 'text' as const, text: `${j.error}${known}` }], isError: true };
      }
      const files = await loadIndex().catch(() => [] as IndexFile[]);
      const byPath = new Map(files.map((f) => [f.path, f]));
      const lines = (j.items ?? []).map((it) => {
        if (it.type !== 'image' || !it.path) {
          const label = it.type === 'note' ? 'note' : 'text';
          return `- [${label}] ${it.text ? JSON.stringify(it.text.slice(0, 160)) : '(empty)'}`;
        }
        const f = byPath.get(it.path);
        return `- ${f ? describe(f) : it.path + ' (not in the index; file may be missing)'}`;
      });
      const head = `${j.project} / ${j.canvas}: ${lines.length} item${lines.length === 1 ? '' : 's'}, in reading order:`;
      return { content: [{ type: 'text' as const, text: [head, ...lines].join('\n') }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Could not read that canvas: ${message}. Studiolo must be running on ${HQ}.` }], isError: true };
    }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────


// ── Tool: describe_item ───────────────────────────────────────────────────────

server.tool(
  'describe_item',
  `Write the name and note for one item in the archive.

This is the tool that earns the server its keep. Describing an archive by hand is the slow,
valuable work that makes everything else findable — search by meaning has nothing to rank without
it, and list_folders will tell you exactly which folders are thin.

Look at the image with view_inspo FIRST, then describe what is actually there. A guess from the
filename is worse than no description: it will be searched, believed, and never checked.

The NAME is one line — what this is, in the words somebody would look for. It becomes the item's
name everywhere in the app. The NOTE is the longer thought: why it was kept, what to steal from it.
Either can be left out to keep what is already written; passing an empty string clears it.

Writes to the _manifest.md file beside the image, in plain Markdown, so the words outlive this app.`,
  {
    path: z.string().describe('The item, as search_inspo reports it: "@<root>/<folder>/<file>".'),
    name: z.string().optional().describe('One line. What this is. Omit to leave the existing one.'),
    note: z.string().optional().describe('The longer thought. Omit to leave the existing one.'),
  },
  async ({ path, name, note }) => {
    try {
      if (name === undefined && note === undefined) {
        return { content: [{ type: 'text' as const, text: 'Nothing to write. Pass a name, a note, or both.' }], isError: true };
      }
      const files = await loadIndex();
      const f = files.find((x) => x.path === path);
      if (!f) {
        return { content: [{ type: 'text' as const, text: `No item at ${path}. Use search_inspo to get exact paths.` }], isError: true };
      }
      /* Only what is being changed. The route treats an absent field as "leave alone" and an
         empty string as "clear", so there is nothing to read back and nothing to send back —
         which is the point: reading the other field from `/api/inspo-index` meant reading it from
         a cache up to 1.5s old, and two calls inside that window had the second one revert the
         first with a stale value. (Audit 2026-08-17, P3-2.) */
      await post('/api/manifest-update', {
        path,
        ...(name === undefined ? {} : { screen: name }),
        ...(note === undefined ? {} : { note }),
      });
      const said = [name !== undefined && `name: ${name || '(cleared)'}`, note !== undefined && `note: ${note || '(cleared)'}`]
        .filter(Boolean).join('\n');
      return { content: [{ type: 'text' as const, text: `Written to ${path}.\n${said}` }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Could not write: ${message}. Studiolo must be running on ${HQ}, and the folder must be one it may write to.` }],
        isError: true,
      };
    }
  }
);

// ── Tool: rename_file ─────────────────────────────────────────────────────────

server.tool(
  'rename_file',
  `Rename the file on disk. This changes the filename, not the item's name — use describe_item for
that. Most of the time describe_item is what you want: the name is what the app displays, and a
camera filename is only worth changing when it is actively misleading.

REFUSES for a file that is on a canvas. Renaming one would leave every canvas element pointing at
nothing; the app's own rename fixes those up as it goes, and only the app can, so do it there.

The extension is kept and cannot be changed — it describes the bytes, not the name.`,
  {
    path: z.string().describe('The item, as search_inspo reports it.'),
    name: z.string().describe('The new filename, without an extension.'),
  },
  async ({ path, name }) => {
    try {
      const files = await loadIndex();
      const f = files.find((x) => x.path === path);
      if (!f) {
        return { content: [{ type: 'text' as const, text: `No item at ${path}. Use search_inspo to get exact paths.` }], isError: true };
      }
      let used: Set<string>;
      try {
        used = await pathsOnCanvases();
      } catch (e) {
        // Named separately from the generic failure below, because the generic one tells somebody
        // to check that Studiolo is running and that the folder is writable — both true here, and
        // both the wrong thing to go and look at.
        if (e instanceof CanvasStateUnknown) {
          return {
            content: [{ type: 'text' as const, text: `Refused: ${e.message}, so there is no way to tell whether ${path} is on one. Renaming it could leave a canvas pointing at a file that no longer exists. Open Studiolo and rename it there, or use describe_item to change what it is called without touching the file.` }],
            isError: true,
          };
        }
        throw e;
      }
      if (used.has(path)) {
        return {
          content: [{ type: 'text' as const, text: `Refused: ${path} is on a canvas. Renaming it here would leave that canvas pointing at a file that no longer exists. The app's own rename updates the canvas as it goes. Rename it in Studiolo instead, or describe_item to change what it is called without touching the file.` }],
          isError: true,
        };
      }
      const clean = name.replace(/\.[a-z0-9]{1,5}$/i, '').trim();
      if (!clean) {
        return { content: [{ type: 'text' as const, text: 'A filename cannot be empty.' }], isError: true };
      }
      const j = await post('/api/inspo-move', { from: path, name: clean });
      return { content: [{ type: 'text' as const, text: `Renamed.\n${path}\n→ ${j.to ?? clean}` }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Could not rename: ${message}. Studiolo must be running on ${HQ}, and the folder must be one it may write to.` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'move_file',
  `File an item into a different folder. This is the other half of describe_item: describing makes
a pile findable, filing makes it tidy, and both are the slow work somebody drops things into Inbox
to avoid doing by hand.

Use list_folders first to see what folders exist. The folder is created if it does not exist yet.

REFUSES for a file that is on a canvas, and the reason is worth knowing rather than working around:
canvas elements store the path of the file they show, those elements live inside the app, and only
the app can rewrite them. Studiolo's own move updates every canvas as it goes. A move made from out
here would leave those canvases pointing at nothing, with no way for either side to notice. Move it
in Studiolo instead.

REFUSES ALSO when it cannot find out whether the file is on a canvas. Missing information is not
permission.

The filename and its extension are unchanged — use rename_file for the name. Nothing is overwritten:
a collision gets a numbered suffix. Any description the file has travels with it.`,
  {
    path: z.string().describe('The item, as search_inspo reports it.'),
    folder: z.string().describe("Folder within the root, e.g. 'packaging' or 'type/specimens'. Use '.' for the root itself."),
  },
  async ({ path, folder }) => {
    try {
      const files = await loadIndex();
      const f = files.find((x) => x.path === path);
      if (!f) {
        return { content: [{ type: 'text' as const, text: `No item at ${path}. Use search_inspo to get exact paths.` }], isError: true };
      }
      let used: Set<string>;
      try {
        used = await pathsOnCanvases();
      } catch (e) {
        /* Fail closed, the same way rename_file does and for the same reason, stated at
           pathsOnCanvases: the route answers 404 both when no snapshot has ever been written and
           when the snapshot is unreadable, and unreadable is a state this app manufactures for
           itself when it quarantines a corrupt one. Treating "I cannot tell" as "nothing is on a
           canvas" is how three canvases came to point at nothing. */
        if (e instanceof CanvasStateUnknown) {
          return {
            content: [{ type: 'text' as const, text: `Refused: ${e.message}, so there is no way to tell whether ${path} is on a canvas. Moving it could leave a canvas pointing at a file that no longer exists. Open Studiolo and move it there.` }],
            isError: true,
          };
        }
        throw e;
      }
      if (used.has(path)) {
        return {
          content: [{ type: 'text' as const, text: `Refused: ${path} is on a canvas. Moving it here would leave that canvas pointing at a file that no longer exists — canvas elements hold the path, they live in the app, and only the app can rewrite them. Move it in Studiolo instead, which updates every canvas as it goes.` }],
          isError: true,
        };
      }
      const dest = folder.trim().replace(/^\/+|\/+$/g, '');
      if (dest.includes('..')) {
        return { content: [{ type: 'text' as const, text: 'A folder cannot contain "..".' }], isError: true };
      }
      const j = await post('/api/inspo-move', { from: path, folder: dest === '' ? '.' : dest });
      if (j.unchanged) {
        return { content: [{ type: 'text' as const, text: `Already there.\n${path}` }] };
      }
      return { content: [{ type: 'text' as const, text: `Filed.\n${path}\n→ ${j.to}` }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Could not move: ${message}. Studiolo must be running on ${HQ}, and both folders must be somewhere it may write to.` }],
        isError: true,
      };
    }
  }
);

/* Connected last, after every tool is registered. It was in the middle of the file and the two
   tools added below it registered *after* the transport was live — which happens to work and is
   the wrong shape: a client that listed tools in that window would see a server still growing. */
const transport = new StdioServerTransport();
await server.connect(transport);
