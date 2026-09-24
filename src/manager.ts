/**
 * Worktree + dev-server manager.
 *
 * Discovers git worktrees living next to this handler, assigns each a stable
 * block of ports, and runs the SvelteKit dev server per worktree:
 *   - app → `npm run dev`   (SvelteKit/Vite, PORT env)
 *
 * Processes are spawned detached (their own process group) so that stopping a
 * server kills the entire child tree (vite spawns workers), not just the
 * parent — otherwise the port would stay held and restarts would fail.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

const WORKSPACE_ROOT =
	process.env.WORKSPACE_ROOT ?? join(process.env.HOME ?? "", "programing");
const PORT_BASE = Number(process.env.PORT_BASE ?? 48100);
const PORT_STEP = Number(process.env.PORT_STEP ?? 100);
const STATE_DIR = join(WORKSPACE_ROOT, "handler", "state");
const PORTS_FILE = join(STATE_DIR, "ports.json");
const CATEGORIES_FILE = join(STATE_DIR, "categories.json");
const LOG_RING = 800; // lines kept per server
const RESCAN_MS = 2500; // discovery + health poll cadence
const START_STAGGER_MS = 1500; // delay between queued server starts
// Where the host-side launcher listens (see launcher.ts). The dashboard's
// "Open Claude" button calls it from the browser; empty hides the button.
const LAUNCHER_URL = process.env.LAUNCHER_URL ?? "http://localhost:48010";
// Local Supabase demo credentials. JWT_SECRET is injected into every worktree
// (see appEnv) AND used to sign the dev-login session cookie — one constant so
// the signer and the verifier can never drift apart.
const LOCAL_JWT_SECRET =
	"super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_DB_URL = "postgresql://postgres:postgres@localhost:54322/postgres";
// The app's session cookie (name via SESSION_COOKIE). Host-only and
// port-agnostic, so one cookie on the PUBLIC_HOST covers every worktree; the
// row it points at lives in the shared local user_session table.
const SESSION_COOKIE = process.env.SESSION_COOKIE ?? "session";
// Absolute session lifetime, mirroring the app's own session cap.
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
// Fallback identity for the dev-login bootstrap when the local DB has no live
// session to reuse (fresh local DB). Blank = require an existing login.
const DEV_LOGIN_MAIL = process.env.DEV_LOGIN_MAIL ?? "";
// Pre-warm each dev server as soon as its port opens, so Vite's lazy SSR
// compile happens before the user clicks (otherwise the first page load
// blocks for ~30s on a cold graph). Set WARMUP=0 to disable.
const WARMUP = process.env.WARMUP !== "0" && process.env.WARMUP !== "false";
// Auto-spin a new worktree's 3 servers on discovery (the default). Set
// AUTOSTART=0 to only discover and leave starting to the user.
const AUTOSTART =
	process.env.AUTOSTART !== "0" && process.env.AUTOSTART !== "false";
// The "main" repo whose gitignored env files seed new worktrees (their app
// server needs the WorkOS/etc. secrets to boot). Set SEED_ENV=0 to disable.
const MAIN_REPO = process.env.MAIN_REPO ?? "main-repo";
const SEED_ENV =
	process.env.SEED_ENV !== "0" && process.env.SEED_ENV !== "false";
const SEED_ENV_FILES = [".env"];
// Let Vite dev servers accept any Host header (e.g. a Tailscale MagicDNS name)
// WITHOUT editing each worktree's vite.config.js — that file lives in
// the app repo and would get pushed. Instead a shared config override merges
// `server.allowedHosts: true` into the worktree's own vite config at spawn time
// (see vite-allowed-hosts.override.mjs next to this source's parent dir). Set
// ALLOW_VITE_HOSTS=0 to disable and use the plain dev script.
const VITE_ALLOWED_HOSTS_OVERRIDE = join(
	WORKSPACE_ROOT,
	"handler",
	"vite-allowed-hosts.override.mjs",
);
const ALLOW_VITE_HOSTS =
	process.env.ALLOW_VITE_HOSTS !== "0" &&
	process.env.ALLOW_VITE_HOSTS !== "false";
// Shared login across worktrees. The MAIN_REPO app runs on the "anchor" port
// and every app's WorkOS login is funneled to one redirect URI; login completes
// there and the app's host-only session cookie (same sealed password via seeding)
// is reused by every app on that same host. Log in once → all apps logged in.
//
// The anchor host/port/redirect all derive from a single knob:
//   - AUTH_REDIRECT_URI set  → use it verbatim (host+port drive everything).
//     e.g. http://192.168.1.50:3000/callback (after allowlisting it in WorkOS)
//          → login + app links on the LAN IP, works across devices.
//   - else APP_AUTH_PORT (3000) → http://localhost:<port>/callback (localhost
//     only; the one URI WorkOS allows out of the box). APP_AUTH_PORT=0 disables.
function resolveAuth(): { uri: string; host: string; port: number } | null {
	const explicit = process.env.AUTH_REDIRECT_URI;
	if (explicit) {
		try {
			const u = new URL(explicit);
			return {
				uri: explicit,
				host: u.hostname,
				port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
			};
		} catch {
			/* fall through to APP_AUTH_PORT */
		}
	}
	const port = Number(process.env.APP_AUTH_PORT ?? 3000) || 0;
	if (!port) {
		return null; // disabled
	}
	return { uri: `http://localhost:${port}/callback`, host: "localhost", port };
}
const AUTH = resolveAuth();
const AUTH_REDIRECT_URI = AUTH?.uri ?? "";
const APP_AUTH_PORT = AUTH?.port ?? 0;
// App "Open" links use the anchor host so the cookie host matches; Storybook
// always uses the advertised LAN IP. Null when shared auth is disabled.
const APP_LINK_HOST = AUTH?.host ?? null;

export type ServerStatus = "stopped" | "starting" | "running" | "crashed";

export interface ServerSpec {
	id: string;
	label: string;
	offset: number; // port = base + offset
	subdir: string; // cwd relative to worktree root
	/** Per-worktree override of `subdir` (e.g. monorepo app subpackage). */
	subdirFor?: (worktreePath: string) => string;
	/** Build the argv for the given port. */
	argv: (port: number) => string[];
	/** Extra env for the given port (and the server's cwd, so .env can be loaded). */
	env?: (
		port: number,
		cwd: string,
		worktreePath?: string,
	) => Record<string, string>;
	/** Path to open in the browser (appended to http://localhost:port). */
	openPath: string;
	/** Auto-spin when a worktree is discovered (default true). */
	autostart?: boolean;
	/** A WorkOS-authenticated Next app: gets the redirect funnel + auth link host. */
	auth?: boolean;
	/** If present and returns false for a worktree, the server is skipped (not
	 *  started) instead of crash-looping — e.g. a Storybook with no config. */
	available?: (worktreePath: string) => boolean;
}

/**
 * Parse a .env file into a flat record. Mirrors Vite's loading (quotes
 * stripped, comments/blank lines skipped) without pulling in a dependency.
 * Used to inject a worktree's own .env into the dev server's process.env —
 * SvelteKit only surfaces .env through `$env/*`, but an app may read
 * `process.env` directly, so the secrets must be present at spawn time.
 */
function loadEnvFile(filePath: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(filePath)) return out;
	const text = readFileSync(filePath, "utf-8");
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
		let val = line.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (key) out[key] = val;
	}
	return out;
}

/**
 * Env for a worktree's dev server: the worktree's own .env (app secrets the
 * app reads from process.env) + local Supabase + (when configured) the auth
 * funnel. Explicit entries below win over .env so local Supabase (DATABASE_URL
 * etc.) takes precedence as the dev DB, while the 9 app secrets come from .env.
 */
function appEnv(
	port: number,
	cwd: string,
	worktreePath?: string,
): Record<string, string> {
	// Load .env, then .env.local (overrides .env, matching Vite's precedence).
	const fromFile = {
		...loadEnvFile(join(cwd, ".env")),
		...loadEnvFile(join(cwd, ".env.local")),
	};
	const e: Record<string, string> = {
		PORT: String(port),
	};
	// Override ORIGIN to match the URL the browser uses to access this worktree.
	// The dashboard links to the LAN IP (resolveHost()), so the browser accesses
	// via e.g. http://192.168.1.50:48800. If ORIGIN stays as localhost:4000
	// (from .env), SvelteKit's CSRF check rejects form submissions and the
	// browser won't store Supabase session cookies (host mismatch in cookie jar).
	const host = APP_LINK_HOST ?? resolveHost();
	e.ORIGIN = `http://${host}:${port}`;
	// Opt a worktree into using its own .env's remote DB/Supabase by placing a
	// `.dev-remote-db` marker file in the worktree root. Without the marker, the
	// local Supabase overrides below take precedence (the default dev DB).
	// Monorepo spawns put cwd in the app dir — also check the worktree root.
	const useRemoteDb = existsSync(join(cwd, ".dev-remote-db")) ||
		existsSync(join(worktreePath ?? cwd, ".dev-remote-db"));
	// Point to the local Supabase instance (started via `supabase start` in the
	// main checkout). This eliminates the remote Supabase cookie issue: session
	// tokens are issued and validated locally, so cookies are always accepted.
	// Use the same LAN host as ORIGIN (not localhost) so storage signed URLs —
	// which the browser fetches directly (auth is server-proxied, storage is
	// not) — are reachable when browsing via the LAN/Tailscale host. Kong binds
	// 0.0.0.0:54321, so the server (same machine) reaches it via the LAN host too.
	if (!useRemoteDb) {
		e.PUBLIC_SUPABASE_URL = `http://${host}:54321`;
		e.PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
		e.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
		e.JWT_SECRET = LOCAL_JWT_SECRET;
		e.DATABASE_URL = `postgresql://postgres:postgres@localhost:54322/postgres`;
		e.DIRECT_URL = `postgresql://postgres:postgres@localhost:54322/postgres`;
	}
	e.LOCAL_MODE = "true";
	if (AUTH_REDIRECT_URI) {
		e.NEXT_PUBLIC_WORKOS_REDIRECT_URI = AUTH_REDIRECT_URI;
		e.WORKOS_REDIRECT_URI = AUTH_REDIRECT_URI;
	}
	// .env first, then explicit local-Supabase/auth overrides on top.
	return { ...fromFile, ...e };
}

/** App subpackage dir when a worktree hosts the app in a monorepo layout:
 *  the first apps/<name> dir holding both package.json and svelte.config.js. */
function monorepoAppSubdir(worktreePath: string): string {
	const appsDir = join(worktreePath, "apps");
	if (!existsSync(appsDir)) return ".";
	for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(appsDir, entry.name);
		if (
			existsSync(join(dir, "package.json")) &&
			existsSync(join(dir, "svelte.config.js"))
		) {
			return `apps/${entry.name}`;
		}
	}
	return ".";
}

export const SERVER_SPECS: ServerSpec[] = [
	{
		id: "app",
		label: "SvelteKit",
		offset: 0,
		subdir: ".",
		// The root `npm run dev` shim delegates to the app subpackage with a chained
		// `npm --prefix`, which swallows the `--host`/`--config` vite args — so
		// monorepo worktrees must spawn directly in the app subpackage.
		subdirFor: (worktreePath) => monorepoAppSubdir(worktreePath),
		// vite reads PORT for the dev-server port; appEnv injects the worktree's
		// own .env (app secrets the app reads from process.env) plus local
		// Supabase (DATABASE_URL etc., which overrides .env for the dev DB).
		// --host 0.0.0.0 binds all interfaces so the LAN IP reaches it (localhost
		// only otherwise). Passed here, not in any worktree's vite.config (keeps it
		// out of git). When the host-override exists, also pass --config <override>
		// so Vite allows any Host header (local-dev only; see ALLOW_VITE_HOSTS).
		argv: () =>
			ALLOW_VITE_HOSTS && existsSync(VITE_ALLOWED_HOSTS_OVERRIDE)
				? ["npm", "run", "dev", "--", "--config", VITE_ALLOWED_HOSTS_OVERRIDE, "--host", "0.0.0.0"]
				: ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
		env: appEnv,
		openPath: "/",
		auth: false,
	},
];

interface LogLine {
	t: number;
	stream: "out" | "err" | "sys";
	text: string;
	/** Sentinel: tells SSE clients to wipe their view (set on a restart clear,
	 *  never stored in the ring buffer, so a fresh reconnect starts clean). */
	clear?: boolean;
}

// Vite's SSR compile is CPU-bound, so warming many cold servers at once just
// makes them all slower — 20 simultaneous starts drove load to ~60 on 24 cores
// and stretched a 36s compile to 88-174s. Cap how many warm at a time; the rest
// queue and take their turn. WARMUP_CONCURRENCY=0 disables the cap.
const WARMUP_CONCURRENCY = Number(process.env.WARMUP_CONCURRENCY ?? 2) || 0;
let warming = 0;
const warmQueue: (() => void)[] = [];

async function acquireWarmSlot(): Promise<void> {
	if (!WARMUP_CONCURRENCY || warming < WARMUP_CONCURRENCY) {
		warming++;
		return;
	}
	await new Promise<void>((resolve) => warmQueue.push(resolve));
	warming++;
}

function releaseWarmSlot() {
	warming--;
	warmQueue.shift()?.();
}

class ServerState {
	status: ServerStatus = "stopped";
	desired: "running" | "stopped" = "stopped";
	pid: number | null = null;
	exitCode: number | null = null;
	startedAt: number | null = null;
	proc: ChildProcess | null = null;
	logs: LogLine[] = [];
	listeners = new Set<(line: LogLine) => void>();

	constructor(
		public spec: ServerSpec,
		public port: number,
	) {}

	log(stream: LogLine["stream"], text: string) {
		pushLogLine(this.logs, this.listeners, stream, text);
	}

	/** Drop the log ring buffer and tell connected SSE clients to clear their
	 *  view. The clear sentinel is broadcast to listeners but NOT stored, so a
	 *  fresh reconnect backfills nothing and starts clean. */
	clearLogs() {
		this.logs.length = 0;
		const line: LogLine = {
			t: Date.now(),
			stream: "sys",
			text: "",
			clear: true,
		};
		for (const fn of this.listeners) {
			fn(line);
		}
	}
}

class Worktree {
	servers = new Map<string, ServerState>();
	setupStatus: "ready" | "installing" | "failed" = "ready";
	setupLogs: LogLine[] = [];
	setupListeners = new Set<(line: LogLine) => void>();
	prBase = ""; // detected base/parent branch for a PR
	prUrl: string | null = null; // GitHub "create PR" compare URL
	repoWeb: string | null = null; // https://github.com/owner/repo
	prComputedFor = ""; // branch the PR fields were last computed for
	prCheckedAt = 0; // last PR/merged refresh (ms) — throttles refetch
	merged = false; // branch's PR was merged into the default branch (main)
	prState: "none" | "open" | "merged" | "closed" = "none";
	prNumber: number | null = null;
	mergedAt = 0; // when the PR merged (ms) — distinguishes a recreated branch
	ci: "none" | "passing" | "failing" | "pending" = "none";
	conflict: "unknown" | "clean" | "conflict" = "unknown"; // would merging with main conflict?
	mergeStatus: "idle" | "merging" | "failed" = "idle"; // merge-main operation
	removable = false; // merged into a long-lived branch AND nothing local-only
	removableReason = ""; // why not removable, for the UI
	removableBase = ""; // the long-lived branch its PR landed in
	createdAt = 0; // when the worktree folder was created (ms) — dashboard order
	constructor(
		public name: string,
		public path: string,
		public base: number,
		public branch: string,
	) {
		for (const spec of SERVER_SPECS) {
			// The main repo's app listens on the WorkOS-allowed auth anchor port.
			const port =
				spec.id === "app" && APP_AUTH_PORT && name === MAIN_REPO
					? APP_AUTH_PORT
					: base + spec.offset;
			this.servers.set(spec.id, new ServerState(spec, port));
		}
	}

	setupLog(stream: LogLine["stream"], text: string) {
		pushLogLine(this.setupLogs, this.setupListeners, stream, text);
	}
}

/**
 * The host used in "Open" links. Prefer an explicit PUBLIC_HOST, otherwise the
 * machine's LAN IPv4 (so links open on the network, e.g. 192.168.1.50, not
 * localhost). Docker/bridge/loopback interfaces are skipped.
 */
export function resolveHost(): string {
	if (process.env.PUBLIC_HOST) {
		return process.env.PUBLIC_HOST;
	}
	const skip = /^(lo|docker|br-|veth|tun|tap|virbr|cni|flannel)/i;
	const candidates: string[] = [];
	for (const [name, list] of Object.entries(networkInterfaces())) {
		if (skip.test(name)) {
			continue;
		}
		for (const ni of list ?? []) {
			if (ni.family === "IPv4" && !ni.internal) {
				candidates.push(ni.address);
			}
		}
	}
	// Prefer common private LAN ranges over docker's 172.16/12 block.
	return (
		candidates.find((a) => a.startsWith("192.168.")) ??
		candidates.find((a) => a.startsWith("10.")) ??
		candidates[0] ??
		"localhost"
	);
}

// ---- dev-login session helpers -------------------------------------------
//
// Every worktree shares ONE local Postgres and ONE injected JWT_SECRET, and
// the session cookie is host-only/port-agnostic — so a single signed
// cookie authenticates on every worktree's port at once. The handler is the
// only component that knows both the secret it injects and the DB holding
// user_session, so it hand-delivers the cookie: opening any worktree lands
// already logged in, reusing an existing valid session when the browser has
// one (no row churn per page open).

let dbHandle: Bun.SQL | null = null;
function localDb(): Bun.SQL {
	dbHandle ??= new Bun.SQL(LOCAL_DB_URL);
	return dbHandle;
}

/** Decode + HMAC-verify a session cookie. Returns the sid, or null. */
async function readSessionCookie(cookie: string): Promise<string | null> {
	const parts = cookie.split(".");
	if (parts.length !== 3) return null;
	const [h, p, sig] = parts;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(LOCAL_JWT_SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const b64url = (s: string) =>
			Uint8Array.from(
				atob(s.replace(/-/g, "+").replace(/_/g, "/")),
				(c) => c.charCodeAt(0),
			);
		const ok = await crypto.subtle.verify(
			"HMAC",
			key,
			b64url(sig),
			new TextEncoder().encode(`${h}.${p}`),
		);
		if (!ok) return null;
		const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
		return typeof claims?.sid === "string" ? claims.sid : null;
	} catch {
		return null;
	}
}

/** Sign a session cookie value for a row id (HS256, shape jose emits). */
async function signSessionCookie(sid: string): Promise<string> {
	const b64url = (bytes: Uint8Array) =>
		btoa(String.fromCharCode(...bytes))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	const enc = new TextEncoder();
	const header = b64url(
		enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
	);
	const payload = b64url(
		enc.encode(
			JSON.stringify({ sid, iat: Math.floor(Date.now() / 1000) }),
		),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(LOCAL_JWT_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`)),
	);
	return `${header}.${payload}.${b64url(sig)}`;
}

/**
 * Return a valid session cookie for the local dev DB: reuse `existing`
 * when its row is still valid, otherwise mint one for the most recent live
 * login (or DEV_LOGIN_MAIL when the DB has no session yet). Null when no
 * usable identity exists.
 */
export async function ensureDevSession(
	existing: string | undefined,
): Promise<string | null> {
	const db = localDb();
	if (existing) {
		const sid = await readSessionCookie(existing);
		if (sid) {
			const rows = (await db`
				SELECT 1 FROM user_session
				WHERE id = ${sid} AND revoked_at IS NULL
				  AND expires_at > now() AND user_id IS NOT NULL
				LIMIT 1`) as unknown[];
			if (rows.length > 0) return existing;
		}
	}
	// Most recent real login wins ("log in once, everywhere after").
	const recent = (await db`
		SELECT s.user_id FROM user_session s JOIN "User" u ON u."userId" = s.user_id
		WHERE s.revoked_at IS NULL AND s.expires_at > now() AND s.user_id IS NOT NULL
		ORDER BY s.issued_at DESC LIMIT 1`) as { user_id: string }[];
	let userId = recent[0]?.user_id;
	if (!userId && DEV_LOGIN_MAIL) {
		const byMail = (await db`
			SELECT "userId" FROM "User" WHERE mail = ${DEV_LOGIN_MAIL} LIMIT 1`) as {
			userId: string;
		}[];
		userId = byMail[0]?.userId;
	}
	if (!userId) return null;
	// Mint: a new row is the truth, the cookie merely carries its id. The
	// browser cookie outlives the sliding row expiry (absolute cap), matching
	// the app's own session cap.
	const sid = randomUUID();
	const expires = new Date(Date.now() + SESSION_ABSOLUTE_MS);
	await db`
		INSERT INTO user_session
			(id, user_id, auth_method, issued_at, expires_at, last_seen_at)
		VALUES (${sid}, ${userId}, 'PASSWORD', now(), ${expires}, now())`;
	return await signSessionCookie(sid);
}

export { SESSION_COOKIE };

// Warm-up's own session cookie, minted once per handler process and reused for
// every server. Passing `undefined` on each start would take the mint path every
// time — one new user_session row per server start (measured: 24 servers took
// the table from 62 to 246 live rows). Memoizing the *promise* (not the resolved
// value) matters: concurrent starts would otherwise all see "no cookie yet",
// each mint a row, and only the last would be kept.
let warmSessionPromise: Promise<string | null> | null = null;
function warmSession(): Promise<string | null> {
	warmSessionPromise ??= ensureDevSession(undefined).catch(() => null);
	return warmSessionPromise;
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
	return s.replace(/\[[0-9;]*[A-Za-z]/g, "").replace(/\][^]*/g, "");
}

function pushLogLine(
	logs: LogLine[],
	listeners: Set<(line: LogLine) => void>,
	stream: LogLine["stream"],
	text: string,
) {
	for (const raw of text.split("\n")) {
		const clean = stripAnsi(raw).replace(/\s+$/, "");
		if (!clean && stream !== "sys") {
			continue;
		}
		const line: LogLine = { t: Date.now(), stream, text: clean };
		logs.push(line);
		if (logs.length > LOG_RING) {
			logs.shift();
		}
		for (const fn of listeners) {
			fn(line);
		}
	}
}

export class Manager {
	worktrees = new Map<string, Worktree>();
	private portRegistry: Record<string, number> = {};
	// Worktree → category name, plus the ordered list of known categories
	// (so a category persists and keeps its place even when empty).
	private catAssign: Record<string, string> = {};
	private catOrder: string[] = [];
	private startQueue: Array<() => void> = [];
	private queueTimer: ReturnType<typeof setInterval> | null = null;
	private conflictAt = 0; // last conflict sweep (ms)
	private conflictBusy = false;
	private mergedAt = 0; // last merged-worktree sweep (ms)
	private mergedBusy = false;
	private envSweepAt = 0; // last env top-up sweep (ms)
	// Signature of MAIN_REPO's env files at the last top-up (mtime+size), so a
	// sweep is skipped entirely unless a key was actually added or changed.
	private envSig = "";

	constructor() {
		mkdirSync(STATE_DIR, { recursive: true });
		this.loadRegistry();
		this.loadCategories();
	}

	// ---- port registry (stable per-worktree blocks, persisted) -------------

	private loadRegistry() {
		try {
			if (existsSync(PORTS_FILE)) {
				this.portRegistry = JSON.parse(readFileSync(PORTS_FILE, "utf8"));
			}
		} catch {
			this.portRegistry = {};
		}
	}

	private saveRegistry() {
		try {
			writeFileSync(
				PORTS_FILE,
				`${JSON.stringify(this.portRegistry, null, 2)}\n`,
			);
		} catch (e) {
			console.error("failed to persist port registry", e);
		}
	}

	// ---- categories (group worktrees on the dashboard, persisted) ----------

	private loadCategories() {
		try {
			if (existsSync(CATEGORIES_FILE)) {
				const raw = JSON.parse(readFileSync(CATEGORIES_FILE, "utf8"));
				this.catAssign = raw.assignments ?? {};
				this.catOrder = Array.isArray(raw.order) ? raw.order : [];
			}
		} catch {
			this.catAssign = {};
			this.catOrder = [];
		}
		// Any assigned-but-unlisted category gets appended so it's always known.
		for (const cat of Object.values(this.catAssign)) {
			if (cat && !this.catOrder.includes(cat)) {
				this.catOrder.push(cat);
			}
		}
	}

	private saveCategories() {
		try {
			const data = { order: this.catOrder, assignments: this.catAssign };
			writeFileSync(CATEGORIES_FILE, `${JSON.stringify(data, null, 2)}\n`);
		} catch (e) {
			console.error("failed to persist categories", e);
		}
	}

	/** Assign a worktree to a category; an empty category clears the assignment. */
	setCategory(name: string, category: string) {
		const cat = category.trim();
		if (!cat) {
			delete this.catAssign[name];
		} else {
			this.catAssign[name] = cat;
			if (!this.catOrder.includes(cat)) {
				this.catOrder.push(cat);
			}
		}
		this.saveCategories();
	}

	/** Register an (initially empty) category so it shows on the dashboard. */
	createCategory(name: string) {
		const cat = name.trim();
		if (cat && !this.catOrder.includes(cat)) {
			this.catOrder.push(cat);
			this.saveCategories();
		}
	}

	/** Remove a category; its members fall back to Uncategorized. */
	deleteCategory(name: string) {
		const cat = name.trim();
		this.catOrder = this.catOrder.filter((c) => c !== cat);
		for (const [wt, c] of Object.entries(this.catAssign)) {
			if (c === cat) {
				delete this.catAssign[wt];
			}
		}
		this.saveCategories();
	}

	private assignBase(name: string): number {
		if (this.portRegistry[name] != null) {
			return this.portRegistry[name];
		}
		const used = new Set(Object.values(this.portRegistry));
		let idx = 0;
		while (used.has(PORT_BASE + idx * PORT_STEP)) {
			idx++;
		}
		const base = PORT_BASE + idx * PORT_STEP;
		this.portRegistry[name] = base;
		this.saveRegistry();
		return base;
	}

	// ---- discovery ---------------------------------------------------------

	private gitOut(dir: string, args: string[]): string {
		try {
			const r = Bun.spawnSync(["git", "-C", dir, ...args]);
			return r.stdout.toString().trim();
		} catch {
			return "";
		}
	}

	private gitOk(dir: string, args: string[]): boolean {
		try {
			return Bun.spawnSync(["git", "-C", dir, ...args]).exitCode === 0;
		} catch {
			return false;
		}
	}

	/**
	 * When a worktree folder was created (ms), for dashboard ordering. Uses the
	 * filesystem birthtime; on a filesystem that does not record one it falls
	 * back to ctime. Returns 0 when neither is available.
	 */
	private dirCreatedAt(dir: string): number {
		try {
			const st = statSync(dir);
			const t = st.birthtimeMs || st.ctimeMs;
			return Number.isFinite(t) ? t : 0;
		} catch {
			return 0;
		}
	}

	private detectBranch(dir: string): string {
		return this.gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "—";
	}

	/**
	 * The branch this one was created from, per its reflog ("branch: Created
	 * from <ref>"). This is what `git worktree add -b X <base>` / `git checkout
	 * -b X <base>` records — the reliable, non-hardcoded base for a branch with
	 * no PR yet. Returns null when it was created from HEAD/itself/a bare commit
	 * or the ref no longer resolves.
	 */
	private reflogBase(dir: string, head: string): string | null {
		const out = this.gitOut(dir, ["reflog", "show", head]);
		if (!out) {
			return null;
		}
		const created = out
			.split("\n")
			.filter((l) => /branch: Created from /.test(l));
		if (created.length === 0) {
			return null;
		}
		const m = created[created.length - 1].match(/branch: Created from (.+)$/);
		if (!m) {
			return null;
		}
		let ref = m[1]
			.trim()
			.replace(/^refs\/remotes\/origin\//, "")
			.replace(/^refs\/heads\//, "")
			.replace(/^origin\//, "");
		if (
			!ref ||
			ref === "HEAD" ||
			ref === head ||
			/^[0-9a-f]{7,40}$/.test(ref)
		) {
			return null;
		}
		// Only accept it if it actually resolves to a branch.
		if (
			!this.gitOk(dir, ["rev-parse", "--verify", "--quiet", ref]) &&
			!this.gitOk(dir, ["rev-parse", "--verify", "--quiet", `origin/${ref}`])
		) {
			return null;
		}
		return ref;
	}

	/** { owner, repo } from origin, or null for non-GitHub remotes. */
	private detectRepoSlug(dir: string): { owner: string; repo: string } | null {
		let url = this.gitOut(dir, ["remote", "get-url", "origin"]);
		if (!url) {
			return null;
		}
		url = url.replace(/\.git$/, "");
		const m = url.match(/github\.com[:/]+([^/]+)\/(.+)$/);
		return m ? { owner: m[1], repo: m[2] } : null;
	}

	/** The repo's default branch (e.g. main), used as the PR base fallback. */
	private defaultBranch(dir: string): string {
		const ref = this.gitOut(dir, [
			"symbolic-ref",
			"--short",
			"refs/remotes/origin/HEAD",
		]);
		return ref.replace(/^origin\//, "") || "main";
	}

	/**
	 * The repo's permanent branches — a PR merged into one of these means the
	 * branch's work has landed. The default branch alone is not enough: some
	 * repos PR into a long-lived branch like `production`, so keying on
	 * origin/HEAD would never flag those.
	 * Only branches that actually exist on the remote are returned.
	 */
	private longLivedBranches(dir: string): string[] {
		return ["dev", "production", "staging", this.defaultBranch(dir)]
			.filter((b, i, a) => b && a.indexOf(b) === i)
			.filter((b) => this.gitOk(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]));
	}

	/**
	 * Fetch the given remote branches into refs/remotes/origin/<b>, over HTTPS
	 * with the token (the container has no SSH key). Returns false if any fetch
	 * fails — callers must treat that as "cannot verify", never as "safe".
	 */
	private fetchBases(ref: string, bases: string[]): boolean {
		const slug = this.detectRepoSlug(ref);
		const token = process.env.GH_TOKEN;
		if (!slug || !token) {
			return false;
		}
		const url = `https://x-access-token:${token}@github.com/${slug.owner}/${slug.repo}.git`;
		const results = bases.map((b) => {
			const r = Bun.spawnSync([
				"git",
				"-C",
				ref,
				"fetch",
				url,
				`+${b}:refs/remotes/origin/${b}`,
			]);
			if (r.exitCode !== 0) {
				console.error(
					`fetch ${b} failed (${r.exitCode}): ${r.stderr.toString().trim().slice(0, 300)}`,
				);
			}
			return r.exitCode === 0;
		});
		return results.every(Boolean);
	}

	/**
	 * A branch's creation time (ms) from its reflog, or 0 when unknown. Guards
	 * against branch-name reuse: a branch deleted after its PR merged and later
	 * recreated under the same name still carries the old PR's merged state, so
	 * the merge must be newer than the branch for it to mean anything.
	 */
	private branchCreatedAt(dir: string, branch: string): number {
		const out = this.gitOut(dir, [
			"reflog",
			"show",
			"--date=unix",
			"--format=%gd %cd %gs",
			branch,
		]);
		if (!out) {
			return 0;
		}
		const created = out
			.split("\n")
			.filter((l) => /branch: Created from /.test(l));
		if (created.length === 0) {
			return 0;
		}
		// `%gd` for a branch entry is `<branch>@{<unix>}`, so the timestamp is
		// already in the selector and survives even without %cd.
		const m = created[created.length - 1].match(/@\{(\d{9,})\}/);
		return m ? Number(m[1]) * 1000 : 0;
	}

	/**
	 * The ground-truth PR base from GitHub: the base ref of the branch's PR
	 * (preferring an open one, else the most recent). Returns null if there's no
	 * PR, no token, or the request fails. Requires GH_TOKEN (a `gh auth token`).
	 */
	private async gh(path: string): Promise<unknown | null> {
		const token = process.env.GH_TOKEN;
		if (!token) {
			return null;
		}
		try {
			const r = await fetch(`https://api.github.com${path}`, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": "worktree-handler",
				},
			});
			if (!r.ok) {
				return null;
			}
			return await r.json();
		} catch {
			return null;
		}
	}

	/** The branch's PR (preferring an open one, else the most recent), or null. */
	private async fetchPr(
		owner: string,
		repo: string,
		branch: string,
	): Promise<{
		number: number;
		base: string;
		state: "open" | "merged" | "closed";
		merged: boolean;
		mergedAt: number;
		headSha: string;
		htmlUrl: string;
	} | null> {
		const head = `${owner}:${encodeURIComponent(branch)}`;
		const arr = (await this.gh(
			`/repos/${owner}/${repo}/pulls?head=${head}&state=all&per_page=20`,
		)) as Array<{
			number: number;
			state: string;
			merged_at: string | null;
			base: { ref: string };
			head: { sha: string };
			html_url: string;
		}> | null;
		if (!Array.isArray(arr) || arr.length === 0) {
			return null;
		}
		const pr = arr.find((p) => p.state === "open") ?? arr[0];
		const merged = pr.merged_at != null;
		return {
			number: pr.number,
			base: pr.base?.ref ?? "",
			state: merged ? "merged" : pr.state === "open" ? "open" : "closed",
			merged,
			mergedAt: pr.merged_at ? Date.parse(pr.merged_at) || 0 : 0,
			headSha: pr.head?.sha ?? "",
			htmlUrl: pr.html_url,
		};
	}

	/** Aggregate CI state for a commit from its GitHub check runs. */
	private async fetchCi(
		owner: string,
		repo: string,
		sha: string,
	): Promise<"none" | "passing" | "failing" | "pending"> {
		if (!sha) {
			return "none";
		}
		const data = (await this.gh(
			`/repos/${owner}/${repo}/commits/${sha}/check-runs`,
		)) as {
			check_runs?: Array<{ status: string; conclusion: string | null }>;
		} | null;
		const runs = data?.check_runs ?? [];
		if (runs.length === 0) {
			return "none";
		}
		if (runs.some((r) => r.status !== "completed")) {
			return "pending";
		}
		const bad = [
			"failure",
			"timed_out",
			"cancelled",
			"action_required",
			"stale",
		];
		if (runs.some((r) => r.conclusion && bad.includes(r.conclusion))) {
			return "failing";
		}
		return "passing";
	}

	/**
	 * Resolve the PR base for a worktree's branch. Uses the real GitHub PR base
	 * (ground truth) and falls back to the repo's default branch when there's no
	 * PR yet. Async + fire-and-forget from discover(); fields populate on the
	 * next state push. Recomputes only when the branch changes.
	 */
	private async computePr(wt: Worktree, force = false) {
		const now = Date.now();
		// Refresh on branch change, else at most every 60s (merged status changes
		// when a PR lands, so we can't cache it forever). `force` bypasses the
		// throttle so a removal can re-read live state instead of a stale flag.
		if (!force && wt.prComputedFor === wt.branch && now - wt.prCheckedAt < 60_000) {
			return;
		}
		wt.prComputedFor = wt.branch; // synchronous guard against concurrent re-fetch
		wt.prCheckedAt = now;
		const def = this.defaultBranch(wt.path);
		const slug = this.detectRepoSlug(wt.path);
		wt.repoWeb = slug ? `https://github.com/${slug.owner}/${slug.repo}` : null;
		const pr =
			slug && wt.branch !== "—"
				? await this.fetchPr(slug.owner, slug.repo, wt.branch)
				: null;
		// The branch's PR actually merged into a long-lived branch — NOT mere git
		// ancestry, which is true for any fresh branch cut from main and gave
		// false "in main" for new branches. `production` counts too: some repos PR
		// into it, and only checking origin/HEAD would never flag those.
		wt.merged = !!(pr && pr.merged && this.longLivedBranches(wt.path).includes(pr.base));
		wt.prState = pr?.state ?? "none";
		wt.prNumber = pr?.number ?? null;
		wt.mergedAt = pr?.mergedAt ?? 0;
		// CI only matters for an open PR (the actionable case).
		wt.ci =
			pr && pr.state === "open" && slug
				? await this.fetchCi(slug.owner, slug.repo, pr.headSha)
				: "none";
		// Base for a new "create PR" link: PR base, else fork point, else default.
		wt.prBase = pr?.base || this.reflogBase(wt.path, wt.branch) || def;
		// Link to the real PR if one exists, else a "create PR" compare URL.
		const enc = (b: string) => encodeURIComponent(b).replace(/%2F/g, "/");
		wt.prUrl =
			pr?.htmlUrl ??
			(wt.repoWeb && wt.branch !== "—" && wt.prBase !== wt.branch
				? `${wt.repoWeb}/compare/${enc(wt.prBase)}...${enc(wt.branch)}?expand=1`
				: null);
	}

	/**
	 * Resolve the GitHub link to open when the user clicks "PR" — built from the
	 * worktree's *live* active branch, re-read from git at click time (not the
	 * cached `wt.branch`/`wt.prUrl`, which can lag by up to a rescan). If an open
	 * PR exists for the branch, returns its URL; otherwise returns a "create PR"
	 * compare URL (base … branch). Returns null with a reason when there's no
	 * branch to PR from (detached HEAD / on the default branch / not GitHub).
	 */
	async resolvePrLink(
		name: string,
	): Promise<{
		url: string | null;
		branch: string;
		base: string;
		reason?: string;
	}> {
		const wt = this.worktrees.get(name);
		if (!wt) {
			return { url: null, branch: "", base: "", reason: "no such worktree" };
		}
		// Re-read the active branch straight from git — the source of truth at
		// click time. Also keep the cached display branch fresh.
		const branch = this.detectBranch(wt.path);
		wt.branch = branch;
		if (!branch || branch === "—" || branch === "HEAD") {
			return { url: null, branch, base: "", reason: "detached HEAD / no branch" };
		}
		const slug = this.detectRepoSlug(wt.path);
		if (!slug) {
			return { url: null, branch, base: "", reason: "not a GitHub repo" };
		}
		const repoWeb = `https://github.com/${slug.owner}/${slug.repo}`;
		// An existing PR wins — open it directly (prefers an open one).
		const pr = await this.fetchPr(slug.owner, slug.repo, branch);
		if (pr?.htmlUrl) {
			return { url: pr.htmlUrl, branch, base: pr.base };
		}
		// No PR yet → "create PR" compare URL. Base = PR base (none here) → reflog
		// fork point → default branch. A branch sitting on the default branch has
		// nothing to PR into, so we bail.
		const def = this.defaultBranch(wt.path);
		let base = this.reflogBase(wt.path, branch) || def;
		if (base === branch) {
			return { url: null, branch, base, reason: "on the default branch" };
		}
		const enc = (b: string) => encodeURIComponent(b).replace(/%2F/g, "/");
		return {
			url: `${repoWeb}/compare/${enc(base)}...${enc(branch)}?expand=1`,
			branch,
			base,
		};
	}

	/**
	 * Provision a worktree's gitignored env files from MAIN_REPO.
	 *
	 * Each destination is seeded from MAIN_REPO's file *at the same relative
	 * path* — never the root file for both. The app dir's .env is a different,
	 * larger file than the root's (it carries the SMTP_* block and other
	 * app-only keys), so copying the root file into the app dir left every new
	 * worktree failing the env schema ("FATAL: ... SMTP_HOST: Required") on its
	 * first SSR request, which surfaced as a wall of 500s in the logs.
	 *
	 * An existing file is topped up with the keys it is missing instead of being
	 * left alone, so a worktree created before a key existed heals itself.
	 * Existing values are never rewritten: a worktree may point its own SMTP at
	 * mailpit rather than the shared relay on purpose.
	 */
	private seedEnv(name: string, full: string) {
		if (!SEED_ENV || name === MAIN_REPO) {
			return;
		}
		const mainDir = join(WORKSPACE_ROOT, MAIN_REPO);
		// Monorepo worktrees load .env from the app dir (Vite envDir) as well as
		// the worktree root; the flat layout only has the root.
		const sub = this.hasMonorepoApp(full) ? this.appSubdir(full) : "";
		const pairs: Array<[string, string]> = [[mainDir, full]];
		if (sub) {
			pairs.push([join(mainDir, sub), join(full, sub)]);
		}
		for (const [srcDir, dstDir] of pairs) {
			for (const rel of SEED_ENV_FILES) {
				const src = join(srcDir, rel);
				const dst = join(dstDir, rel);
				if (!existsSync(src)) {
					continue;
				}
				try {
					mkdirSync(dirname(dst), { recursive: true });
					const added = this.syncEnvFile(src, dst);
					const where = dstDir === full ? "" : ` (${sub})`;
					if (added === null) {
						console.log(`  env${where} ← ${rel}: copied from ${MAIN_REPO}`);
					} else if (added.length > 0) {
						console.log(`  env${where} ← ${rel}: +${added.join(", ")}`);
					}
				} catch (e) {
					console.error(`  failed to seed ${dst}:`, e);
				}
			}
		}
	}

	/**
	 * Signature of MAIN_REPO's env files (path:mtime:size). Cheap — a handful of
	 * stat calls — so the top-up sweep can be skipped whenever nothing changed.
	 */
	private mainEnvSig(): string {
		const mainDir = join(WORKSPACE_ROOT, MAIN_REPO);
		const sub = this.hasMonorepoApp(mainDir) ? this.appSubdir(mainDir) : "";
		const parts: string[] = [];
		for (const dir of sub ? [mainDir, join(mainDir, sub)] : [mainDir]) {
			for (const rel of SEED_ENV_FILES) {
				const p = join(dir, rel);
				try {
					const st = statSync(p);
					parts.push(`${p}:${st.mtimeMs}:${st.size}`);
				} catch {
					// absent — nothing to propagate from here
				}
			}
		}
		return parts.join("|");
	}

	/**
	 * Top up every worktree's env from MAIN_REPO when MAIN_REPO's env changed.
	 * Keeps a worktree created before a key was added from silently breaking on
	 * that key later; seeding a new worktree already covers the common case.
	 */
	private sweepEnv() {
		if (!SEED_ENV) {
			return;
		}
		const sig = this.mainEnvSig();
		if (sig === this.envSig) {
			return;
		}
		this.envSig = sig;
		for (const [name, wt] of this.worktrees) {
			this.seedEnv(name, wt.path);
		}
	}

	/**
	 * Copy `src` over `dst` when `dst` is absent, else append the keys `src` has
	 * that `dst` lacks. Returns the keys added, or null when the file was copied
	 * outright. A new file is copied verbatim so comments and quoting survive; a
	 * top-up writes via a temp file + rename so a concurrent reader never sees a
	 * half-written file.
	 */
	private syncEnvFile(src: string, dst: string): string[] | null {
		if (!existsSync(dst)) {
			copyFileSync(src, dst);
			return null;
		}
		const srcEnv = loadEnvFile(src);
		const dstEnv = loadEnvFile(dst);
		const added = Object.keys(srcEnv).filter((k) => !(k in dstEnv));
		if (added.length === 0) {
			return [];
		}
		const cur = readFileSync(dst, "utf-8");
		const sep = cur && !cur.endsWith("\n") ? "\n" : "";
		const body = added.map((k) => `${k}=${srcEnv[k]}`).join("\n");
		const tmp = `${dst}.handler-tmp`;
		writeFileSync(tmp, `${cur}${sep}${body}\n`);
		renameSync(tmp, dst);
		return added;
	}

	/** Path to a worktree's vite config (first matching extension), or null. */
	private viteConfigPath(dir: string): string | null {
		for (const f of ["vite.config.ts", "vite.config.mjs", "vite.config.js"]) {
			const p = join(dir, f);
			if (existsSync(p)) {
				return p;
			}
		}
		return null;
	}

	/** A fresh git worktree has no node_modules, so `vite` (and friends) is absent. */
	private needsInstall(dir: string): boolean {
		return !existsSync(
			join(dir, this.appSubdir(dir), "node_modules", ".bin", "vite"),
		);
	}

	/** Run `npm install` in the app dir, streaming output to its setup log. */
	private runInstall(wt: Worktree): Promise<boolean> {
		return new Promise((resolve) => {
			wt.setupLog("sys", "$ npm install");
			const proc = spawn("npm", ["install"], {
				cwd: join(wt.path, this.appSubdir(wt.path)),
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			proc.stdout?.on("data", (b: Buffer) => wt.setupLog("out", b.toString()));
			proc.stderr?.on("data", (b: Buffer) => wt.setupLog("err", b.toString()));
			proc.on("error", (e) => {
				wt.setupLog("err", `[install error] ${e.message}`);
				resolve(false);
			});
			proc.on("exit", (code) => {
				wt.setupLog("sys", `npm install exited (code ${code})`);
				resolve(code === 0);
			});
		});
	}

	/**
	 * Prepare a freshly-discovered worktree: install dependencies if missing
	 * (a new git worktree has none), seed env, then auto-start its servers.
	 * Runs async so discovery isn't blocked; the dashboard shows setup status.
	 */
	private async prepareWorktree(wt: Worktree) {
		void this.computePr(wt);
		if (this.needsInstall(wt.path)) {
			wt.setupStatus = "installing";
			console.log(`  ${wt.name}: installing dependencies (npm install)…`);
			const ok = await this.runInstall(wt);
			wt.setupStatus = ok ? "ready" : "failed";
			if (!ok) {
				console.error(
					`  ${wt.name}: npm install failed — not starting servers`,
				);
				return;
			}
			console.log(`  ${wt.name}: dependencies installed`);
		} else {
			wt.setupStatus = "ready";
		}
		this.seedEnv(wt.name, wt.path);
		if (AUTOSTART) {
			for (const spec of SERVER_SPECS) {
				if (spec.autostart !== false) {
					this.queueStart(wt.name, spec.id);
				}
			}
		}
	}

	/** Re-run `bun install` for a worktree on demand (stops servers first). */
	reinstall(name: string) {
		const wt = this.worktrees.get(name);
		if (!wt || wt.setupStatus === "installing") {
			return;
		}
		for (const id of wt.servers.keys()) {
			this.stop(name, id);
		}
		void (async () => {
			wt.setupStatus = "installing";
			const ok = await this.runInstall(wt);
			wt.setupStatus = ok ? "ready" : "failed";
			if (ok) {
				this.seedEnv(wt.name, wt.path);
				if (AUTOSTART) {
					for (const spec of SERVER_SPECS) {
						if (spec.autostart !== false) {
							this.queueStart(name, spec.id);
						}
					}
				}
			}
		})();
	}

	getWorktree(name: string): Worktree | undefined {
		return this.worktrees.get(name);
	}

	/** Run a git command in the worktree, streaming output to its activity log. */
	private runGit(wt: Worktree, args: string[]): Promise<boolean> {
		return new Promise((resolve) => {
			const proc = spawn("git", ["-C", wt.path, ...args], {
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			proc.stdout?.on("data", (b: Buffer) => wt.setupLog("out", b.toString()));
			proc.stderr?.on("data", (b: Buffer) => wt.setupLog("err", b.toString()));
			proc.on("error", (e) => {
				wt.setupLog("err", `[git error] ${e.message}`);
				resolve(false);
			});
			proc.on("exit", (code) => resolve(code === 0));
		});
	}

	/** Run git in an arbitrary dir, capturing stderr for logging. */
	private gitAt(dir: string, args: string[]): Promise<boolean> {
		return new Promise((resolve) => {
			const proc = spawn("git", ["-C", dir, ...args], {
				env: process.env,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let err = "";
			proc.stderr?.on("data", (b: Buffer) => {
				err += b.toString();
			});
			proc.on("error", () => resolve(false));
			proc.on("exit", (code) => {
				if (code !== 0 && err.trim()) {
					console.error(`git ${args.join(" ")} → ${err.trim()}`);
				}
				resolve(code === 0);
			});
		});
	}

	/**
	 * Delete a worktree: stop its servers, run `git worktree remove --force`
	 * (run from another worktree of the same repo), free its port block, and drop
	 * it from state. Refuses to delete the main repo. Falls back to removing the
	 * directory + `git worktree prune` if the git command can't.
	 */
	async deleteWorktree(name: string): Promise<{ ok: boolean; error?: string }> {
		const wt = this.worktrees.get(name);
		if (!wt) {
			return { ok: false, error: "no such worktree" };
		}
		if (name === MAIN_REPO) {
			return {
				ok: false,
				error: `refusing to delete the main repo (${MAIN_REPO})`,
			};
		}

		for (const id of wt.servers.keys()) {
			this.stop(name, id); // stop servers first
		}

		// `git worktree remove` must run from a *different* worktree/repo.
		const host = [
			join(WORKSPACE_ROOT, MAIN_REPO),
			...[...this.worktrees.values()].map((w) => w.path),
		].find((d) => d !== wt.path && existsSync(join(d, ".git")));

		console.log(`× deleting worktree ${name} (${wt.path})`);
		let removed = host
			? await this.gitAt(host, ["worktree", "remove", "--force", wt.path])
			: false;
		if (!removed) {
			// Fallback: remove the directory and let git prune its bookkeeping.
			try {
				rmSync(wt.path, { recursive: true, force: true });
			} catch (e) {
				return { ok: false, error: `could not remove folder: ${String(e)}` };
			}
			if (host) {
				await this.gitAt(host, ["worktree", "prune"]);
			}
			removed = !existsSync(wt.path);
		}
		if (!removed) {
			return { ok: false, error: "failed to remove worktree" };
		}

		delete this.portRegistry[name]; // free the port block for reuse
		this.saveRegistry();
		this.worktrees.delete(name);
		return { ok: true };
	}

	/**
	 * Whether a worktree's work has provably landed and it holds nothing else, so
	 * removing it cannot lose anything. Requires ALL of:
	 *   - a PR for this branch merged into a long-lived branch;
	 *   - the merge is newer than the branch itself (a branch deleted and recreated
	 *     under the same name would otherwise inherit the old PR's merged state);
	 *   - no uncommitted or untracked changes (`git status --porcelain` empty);
	 *   - HEAD contained in origin/<base> — every local commit is in the base
	 *     branch. This is what catches a worktree whose PR merged but which still
	 *     has an unpushed commit (ancestry is strictly stronger than "headSha ==
	 *     HEAD", which `Merge main` legitimately invalidates).
	 * Returns a reason string suitable for showing the user.
	 */
	private assessRemovable(
		wt: Worktree,
	): { ok: boolean; reason: string; checks: { merged: boolean; inBase: boolean; clean: boolean } } {
		const checks = { merged: false, inBase: false, clean: false };
		const fail = (reason: string) => ({ ok: false, reason, checks });
		if (wt.name === MAIN_REPO) {
			return fail("the main repo");
		}
		// A detached worktree reports the literal "HEAD" (not the "—" sentinel),
		// so both must be rejected — there is no branch to reason about.
		if (!wt.branch || wt.branch === "—" || wt.branch === "HEAD") {
			return fail("detached HEAD — no branch to verify");
		}
		if (wt.prState !== "merged") {
			return fail(wt.prNumber ? `PR #${wt.prNumber} is not merged` : "no merged PR");
		}
		const base = wt.prBase;
		if (!this.longLivedBranches(wt.path).includes(base)) {
			return fail(`merged into “${base || "unknown"}”, not a long-lived branch`);
		}
		checks.merged = true;
		if (!wt.mergedAt || this.branchCreatedAt(wt.path, wt.branch) > wt.mergedAt) {
			return fail("branch was recreated after the PR merged");
		}
		if (this.gitOut(wt.path, ["status", "--porcelain"])) {
			return fail("uncommitted or untracked changes");
		}
		checks.clean = true;
		const head = this.gitOut(wt.path, ["rev-parse", "HEAD"]);
		if (!head) {
			return fail("could not read HEAD");
		}
		if (!this.gitOk(wt.path, ["merge-base", "--is-ancestor", head, `refs/remotes/origin/${base}`])) {
			return fail(`has commits not in origin/${base}`);
		}
		checks.inBase = true;
		return { ok: true, reason: `merged into ${base}`, checks };
	}

	/**
	 * Mark every worktree that is provably finished. Read-only: it never removes
	 * anything — the dashboard surfaces the flags and the user decides. Throttled
	 * and guarded like checkConflicts.
	 */
	private async sweepMerged() {
		if (this.mergedBusy) {
			return;
		}
		this.mergedBusy = true;
		try {
			const wts = [...this.worktrees.values()].filter(
				(w) => w.name !== MAIN_REPO && w.prState === "merged",
			);
			// Fetch each base we're about to judge against. Without this the local
			// refs are stale (production was 4 days old) and a merge that landed an
			// hour ago would look unmerged. Only long-lived branches: a PR into a
			// feature branch has a base that may already be deleted on merge, and
			// fetching that would fail the whole sweep. Fail closed: skip what we
			// cannot verify.
			const ref = wts[0]?.path;
			if (ref) {
				const longLived = this.longLivedBranches(ref);
				if (longLived.length > 0 && !this.fetchBases(ref, longLived)) {
					for (const wt of wts) {
						wt.removable = false;
						wt.removableReason = "could not refresh remote refs";
					}
					return;
				}
			}
			for (const wt of this.worktrees.values()) {
				if (wt.name === MAIN_REPO || wt.prState !== "merged") {
					wt.removable = false;
					wt.removableReason = "";
					continue;
				}
				const a = this.assessRemovable(wt);
				wt.removable = a.ok;
				wt.removableReason = a.ok ? "" : a.reason;
				wt.removableBase = a.ok ? wt.prBase : "";
			}
		} catch (e) {
			console.error("merged sweep failed:", e);
		} finally {
			this.mergedBusy = false;
		}
	}

	/**
	 * Remove a worktree whose work has landed, and its local branch with it. The
	 * safety rule is re-evaluated here against freshly fetched refs — never the
	 * cached flag, which can be up to a sweep old and may predate a new commit.
	 */
	async removeMerged(name: string): Promise<{ ok: boolean; error?: string }> {
		const wt = this.worktrees.get(name);
		if (!wt) {
			return { ok: false, error: "no such worktree" };
		}
		if (name === MAIN_REPO) {
			return { ok: false, error: `refusing to delete the main repo (${MAIN_REPO})` };
		}

		await this.computePr(wt, true); // live PR state, not a cached verdict
		const bases = [...new Set([wt.prBase, ...this.longLivedBranches(wt.path)])].filter(Boolean);
		if (bases.length === 0 || !this.fetchBases(wt.path, bases)) {
			return { ok: false, error: "could not verify: failed to refresh remote refs" };
		}
		const a = this.assessRemovable(wt);
		if (!a.ok) {
			return { ok: false, error: `not safe to remove: ${a.reason}` };
		}

		const branch = wt.branch;
		const base = wt.prBase;
		const tip = this.gitOut(wt.path, ["rev-parse", "HEAD"]);
		const r = await this.deleteWorktree(name);
		if (!r.ok) {
			return r;
		}
		// Delete the branch only after the folder is gone, and only once more
		// confirmed the tip is in the base. -D (not -d): -d compares against the
		// host worktree's HEAD, which is unrelated.
		const host = [
			join(WORKSPACE_ROOT, MAIN_REPO),
			...[...this.worktrees.values()].map((w) => w.path),
		].find((d) => existsSync(join(d, ".git")));
		if (host && branch && branch !== "—" && branch !== "HEAD") {
			if (this.gitOk(host, ["merge-base", "--is-ancestor", tip, `refs/remotes/origin/${base}`])) {
				const okBranch = await this.gitAt(host, ["branch", "-D", branch]);
				console.log(`× deleted branch ${branch} of ${name} (${okBranch ? "ok" : "failed"})`);
			}
		}
		return { ok: true };
	}

	/** Remove every worktree that is provably finished. Sequential on purpose:
	 * concurrent removals race on the repo's shared git worktree metadata. */
	async cleanMerged(): Promise<{
		removed: string[];
		skipped: Array<{ name: string; reason: string }>;
		failed: Array<{ name: string; error: string }>;
	}> {
		const removed: string[] = [];
		const skipped: Array<{ name: string; reason: string }> = [];
		const failed: Array<{ name: string; error: string }> = [];
		for (const wt of [...this.worktrees.values()]) {
			if (wt.name === MAIN_REPO) {
				continue;
			}
			if (!wt.removable) {
				skipped.push({
					name: wt.name,
					reason: wt.removableReason || "not merged",
				});
				continue;
			}
			const r = await this.removeMerged(wt.name);
			if (r.ok) {
				removed.push(wt.name);
			} else {
				failed.push({ name: wt.name, error: r.error ?? "unknown error" });
			}
		}
		return { removed, skipped, failed };
	}

	/**
	 * Fetch the default branch and merge it into the worktree's branch, to bring
	 * it up to date with main. Output goes to the worktree's log; on conflict the
	 * merge is left in place for the user to resolve (or `git merge --abort`).
	 */
	mergeMain(name: string) {
		const wt = this.worktrees.get(name);
		if (!wt || wt.mergeStatus === "merging") {
			return;
		}
		const def = this.defaultBranch(wt.path);
		const slug = this.detectRepoSlug(wt.path);
		const token = process.env.GH_TOKEN;
		wt.mergeStatus = "merging";
		void (async () => {
			// The origin is usually an SSH remote, but the container has no SSH
			// key — so fetch the default branch over HTTPS with the token, then
			// merge FETCH_HEAD. (Falls back to the local origin ref without a token.)
			let mergeRef = `origin/${def}`;
			if (slug && token) {
				wt.setupLog(
					"sys",
					`$ git fetch https://github.com/${slug.owner}/${slug.repo} ${def}`,
				);
				const url = `https://x-access-token:${token}@github.com/${slug.owner}/${slug.repo}.git`;
				const fetched = await this.runGit(wt, ["fetch", url, def]);
				if (!fetched) {
					wt.setupLog("err", "git fetch failed");
					wt.mergeStatus = "failed";
					return;
				}
				mergeRef = "FETCH_HEAD";
			} else {
				wt.setupLog("sys", `(no GH_TOKEN) merging local origin/${def}`);
			}
			wt.setupLog(
				"sys",
				`$ git merge --no-edit ${mergeRef === "FETCH_HEAD" ? `${def} (FETCH_HEAD)` : mergeRef}`,
			);
			// A merge commit needs an identity; the container has none, so pass
			// one (configurable via GIT_USER_NAME / GIT_USER_EMAIL).
			const idArgs: string[] = [];
			if (process.env.GIT_USER_NAME) {
				idArgs.push("-c", `user.name=${process.env.GIT_USER_NAME}`);
			}
			if (process.env.GIT_USER_EMAIL) {
				idArgs.push("-c", `user.email=${process.env.GIT_USER_EMAIL}`);
			}
			const ok = await this.runGit(wt, [
				...idArgs,
				"merge",
				"--no-edit",
				mergeRef,
			]);
			if (ok) {
				wt.setupLog("sys", `merged ${def} into ${wt.branch}`);
				wt.mergeStatus = "idle";
			} else {
				wt.setupLog(
					"err",
					`merge failed — resolve conflicts in ${wt.path}, or run \`git merge --abort\``,
				);
				wt.mergeStatus = "failed";
			}
		})();
	}

	private isWorktree(dir: string, full: string): boolean {
		if (dir === "handler" || dir.startsWith(".")) {
			return false;
		}
		// Two layouts: the old flat root (package.json + svelte.config.js) and
		// the monorepo layout where the app lives under apps/<name> —
		// a worktree on the monorepo layout has no root svelte.config.
		return (
			(existsSync(join(full, "package.json")) &&
				existsSync(join(full, "svelte.config.js"))) ||
			this.hasMonorepoApp(full)
		);
	}

	/** True when the worktree hosts the app in an apps/<name> dir (monorepo). */
	private hasMonorepoApp(full: string): boolean {
		return monorepoAppSubdir(full) !== ".";
	}

	/** Directory the dev server must run in (monorepos: the app subpackage). */
	private appSubdir(worktreePath: string): string {
		return monorepoAppSubdir(worktreePath);
	}

	/** Discover worktrees; auto-start new ones, drop removed ones. */
	discover() {
		let entries: string[] = [];
		try {
			entries = readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);
		} catch (e) {
			console.error("cannot read workspace root", WORKSPACE_ROOT, e);
			return;
		}

		const present = new Set<string>();
		for (const name of entries) {
			const full = join(WORKSPACE_ROOT, name);
			if (!this.isWorktree(name, full)) {
				continue;
			}
			present.add(name);

			let wt = this.worktrees.get(name);
			if (!wt) {
				const base = this.assignBase(name);
				wt = new Worktree(name, full, base, this.detectBranch(full));
				this.worktrees.set(name, wt);
				console.log(
					`+ worktree ${name} (${wt.branch}) → ports ${base}-${base + 2}`,
				);
				void this.prepareWorktree(wt); // install deps (if needed) → seed → start
			} else {
				wt.branch = this.detectBranch(full); // branch may change
				void this.computePr(wt); // recomputes only if the branch changed
			}
			// Re-read every tick: a folder removed and re-added under the same name
			// gets a new birthtime and must move to the top of the dashboard.
			wt.createdAt = this.dirCreatedAt(full);
		}

		// Remove worktrees that vanished.
		for (const name of [...this.worktrees.keys()]) {
			if (!present.has(name)) {
				console.log(`- worktree ${name} removed; stopping servers`);
				const wt = this.worktrees.get(name)!;
				for (const id of wt.servers.keys()) {
					this.stop(name, id);
				}
				this.worktrees.delete(name);
			}
		}
	}

	// ---- staggered start queue (avoids a thundering herd on boot) ----------

	private queueStart(name: string, id: string) {
		const srv = this.worktrees.get(name)?.servers.get(id);
		if (srv) {
			srv.desired = "running";
			if (srv.status === "stopped" || srv.status === "crashed") {
				srv.status = "starting";
			}
		}
		this.startQueue.push(() => this.start(name, id));
		if (!this.queueTimer) {
			const drain = () => {
				const job = this.startQueue.shift();
				if (job) {
					job();
				}
				if (this.startQueue.length === 0 && this.queueTimer) {
					clearInterval(this.queueTimer);
					this.queueTimer = null;
				}
			};
			drain();
			if (this.startQueue.length > 0) {
				this.queueTimer = setInterval(drain, START_STAGGER_MS);
			}
		}
	}

	// ---- process lifecycle -------------------------------------------------

	start(name: string, id: string) {
		const wt = this.worktrees.get(name);
		const srv = wt?.servers.get(id);
		if (!wt || !srv) {
			return;
		}
		if (srv.proc) {
			return; // already up
		}
		// Skip servers whose config isn't in this branch (e.g. a Storybook only
		// some branches define) rather than letting them crash-loop.
		if (srv.spec.available && !srv.spec.available(wt.path)) {
			srv.desired = "stopped";
			srv.status = "stopped";
			srv.log(
				"sys",
				`${srv.spec.label}: not configured in this branch — skipped`,
			);
			return;
		}
		srv.desired = "running";

		const subdir = srv.spec.subdirFor
			? srv.spec.subdirFor(wt.path)
			: srv.spec.subdir;
		const cwd = join(wt.path, subdir);
		const argv = srv.spec.argv(srv.port);
		const extraEnv = srv.spec.env?.(srv.port, cwd, wt.path) ?? {};
		// Point the Vite host-override at this worktree's real vite.config so it
		// can merge allowedHosts into it (the override loads it by absolute path).
		if (argv.includes(VITE_ALLOWED_HOSTS_OVERRIDE)) {
			const base = this.viteConfigPath(cwd);
			if (base) {
				extraEnv.VITE_BASE_CONFIG_ABS = base;
			}
		}
		srv.status = "starting";
		srv.exitCode = null;
		srv.startedAt = Date.now();
		srv.log(
			"sys",
			`$ ${argv.join(" ")}  (cwd: ${subdir}, port ${srv.port})`,
		);

		const proc = spawn(argv[0], argv.slice(1), {
			cwd,
			detached: true, // own process group → killable as a tree
			env: { ...process.env, ...extraEnv, FORCE_COLOR: "0", BROWSER: "none" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		srv.proc = proc;
		srv.pid = proc.pid ?? null;
		// Vite compiles the SSR module graph lazily, on the first request — so
		// without a warm-up the first page load after a start pays the whole
		// cost (measured 32-36s, the blank-page wait). Nudge it as soon as the
		// port accepts so the compile happens in the background while the user
		// is still on the dashboard.
		this.warmUpWhenReady(srv);

		proc.stdout?.on("data", (b: Buffer) => srv.log("out", b.toString()));
		proc.stderr?.on("data", (b: Buffer) => srv.log("err", b.toString()));
		proc.on("error", (e) => srv.log("err", `[spawn error] ${e.message}`));
		proc.on("exit", (code, signal) => {
			srv.proc = null;
			srv.pid = null;
			srv.exitCode = code;
			const how = signal ? `signal ${signal}` : `code ${code}`;
			srv.log("sys", `process exited (${how})`);
			if (srv.desired === "stopped") {
				srv.status = "stopped";
			} else {
				// Unexpected exit — mark crashed, do NOT auto-loop. User restarts.
				srv.status = "crashed";
			}
		});
	}

	/**
	 * Fire-and-forget warm-up: wait for the port to accept, then make one
	 * request so Vite compiles the SSR module graph before the user clicks.
	 * Purely an optimization — every failure is swallowed.
	 */
	private async warmUpWhenReady(srv: ServerState) {
		if (!WARMUP) return;
		await acquireWarmSlot();
		try {
			// Warm the exact URL a user lands on: the authed page at openPath,
			// followed through its redirect (e.g. / → /teacher/exams). That is the
			// module graph the first real click needs, so compile it up front.
			// Polling with a real request (not a TCP probe) because a bare connect
			// can succeed a beat before the HTTP server accepts.
			const cookie = await warmSession();
			const url = `http://127.0.0.1:${srv.port}${srv.spec.openPath}`;
			for (let i = 0; i < 120; i++) {
				await Bun.sleep(1000);
				if (srv.proc === null) return; // stopped/crashed while waiting
				const t0 = Date.now();
				try {
					const res = await fetch(url, {
						signal: AbortSignal.timeout(180_000),
						headers: cookie
							? { accept: "text/html", cookie: `${SESSION_COOKIE}=${cookie}` }
							: { accept: "text/html" },
					});
					if (res.status < 500) {
						srv.log(
							"sys",
							`warm-up: compiled ${new URL(res.url).pathname} in ${((Date.now() - t0) / 1000).toFixed(1)}s — later loads are fast`,
						);
						return;
					}
				} catch {
					// not listening yet — keep waiting
				}
			}
		} finally {
			releaseWarmSlot();
		}
	}

	stop(name: string, id: string) {
		const srv = this.worktrees.get(name)?.servers.get(id);
		if (!srv) {
			return;
		}
		srv.desired = "stopped";
		const proc = srv.proc;
		if (!proc || proc.pid == null) {
			srv.status = "stopped";
			return;
		}
		srv.log("sys", "stopping…");
		const pid = proc.pid;
		try {
			process.kill(-pid, "SIGTERM"); // whole group
		} catch {
			try {
				proc.kill("SIGTERM");
			} catch {}
		}
		// Force-kill if it lingers.
		setTimeout(() => {
			if (srv.proc === proc) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					try {
						proc.kill("SIGKILL");
					} catch {}
				}
			}
		}, 6000);
	}

	restart(name: string, id: string) {
		const srv = this.worktrees.get(name)?.servers.get(id);
		if (!srv) {
			return;
		}
		// A restart starts fresh: drop prior logs so only output since this
		// restart remains (also wipes the view for any open log modal).
		srv.clearLogs();
		if (srv.proc) {
			srv.desired = "running";
			const proc = srv.proc;
			// restart once the old process is gone
			proc.once("exit", () => setTimeout(() => this.start(name, id), 400));
			this.stopOnly(name, id);
		} else {
			this.start(name, id);
		}
	}

	/** Kill without flipping desired to stopped (used by restart). */
	private stopOnly(name: string, id: string) {
		const srv = this.worktrees.get(name)?.servers.get(id);
		const proc = srv?.proc;
		if (!proc || proc.pid == null) {
			return;
		}
		const pid = proc.pid;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				proc.kill("SIGTERM");
			} catch {}
		}
		setTimeout(() => {
			if (srv?.proc === proc) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {}
			}
		}, 6000);
	}

	startWorktree(name: string) {
		// Manual "Start all" starts every server (including opt-in ones).
		for (const id of this.worktrees.get(name)?.servers.keys() ?? []) {
			this.queueStart(name, id);
		}
	}
	stopWorktree(name: string) {
		for (const id of this.worktrees.get(name)?.servers.keys() ?? []) {
			this.stop(name, id);
		}
	}
	restartWorktree(name: string) {
		for (const id of this.worktrees.get(name)?.servers.keys() ?? []) {
			this.restart(name, id);
		}
	}

	// ---- global (all worktrees) ----
	startEverything() {
		for (const name of this.worktrees.keys()) {
			this.startWorktree(name);
		}
	}
	stopEverything() {
		for (const name of this.worktrees.keys()) {
			this.stopWorktree(name);
		}
	}
	restartEverything() {
		for (const name of this.worktrees.keys()) {
			this.restartWorktree(name);
		}
	}

	// ---- health probing ----------------------------------------------------

	private async probe(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const sock = connect({ host: "127.0.0.1", port });
			const done = (ok: boolean) => {
				sock.destroy();
				resolve(ok);
			};
			sock.setTimeout(1000);
			sock.once("connect", () => done(true));
			sock.once("timeout", () => done(false));
			sock.once("error", () => done(false));
		});
	}

	async health() {
		const checks: Promise<void>[] = [];
		for (const wt of this.worktrees.values()) {
			for (const srv of wt.servers.values()) {
				if (srv.status === "starting" || srv.status === "running") {
					checks.push(
						this.probe(srv.port).then((open) => {
							if (srv.proc) {
								srv.status = open ? "running" : "starting";
							}
						}),
					);
				}
			}
		}
		await Promise.all(checks);
	}

	// ---- serialization for the API -----------------------------------------

	snapshot() {
		const host = resolveHost();
		return {
			workspaceRoot: WORKSPACE_ROOT,
			host,
			launcher: LAUNCHER_URL,
			categories: this.catOrder,
			worktrees: [...this.worktrees.values()].map((wt) => ({
				name: wt.name,
				path: wt.path,
				branch: wt.branch,
				base: wt.base,
				createdAt: wt.createdAt,
				category: this.catAssign[wt.name] ?? "",
				isMain: wt.name === MAIN_REPO,
				setup: wt.setupStatus,
				merged: wt.merged,
				removable: wt.removable,
				removableReason: wt.removableReason,
				removableBase: wt.removableBase,
				prState: wt.prState,
				prNumber: wt.prNumber,
				ci: wt.ci,
				conflict: wt.conflict,
				merging: wt.mergeStatus === "merging",
				mergeFailed: wt.mergeStatus === "failed",
				prBase: wt.prBase,
				prUrl: wt.prUrl,
				servers: [...wt.servers.values()].map((s) => ({
					id: s.spec.id,
					label: s.spec.label,
					port: s.port,
					// The app is opened through the dev-login bootstrap so the
					// browser lands already authenticated (see devLogin).
					url:
						s.spec.id === "app"
							? `/api/dev-login?worktree=${encodeURIComponent(wt.name)}`
							: `http://${s.spec.auth && APP_LINK_HOST ? APP_LINK_HOST : host}:${s.port}${s.spec.openPath}`,
					status: s.status,
					desired: s.desired,
					pid: s.pid,
					exitCode: s.exitCode,
					startedAt: s.startedAt,
					logLines: s.logs.length,
				})),
			})),
		};
	}

	getServer(name: string, id: string): ServerState | undefined {
		return this.worktrees.get(name)?.servers.get(id);
	}

	/**
	 * Resolve the dev-login redirect for a worktree: ensure a session cookie,
	 * then point at the app server. Returns null when the worktree has no app
	 * server to open.
	 */
	async devLogin(
		name: string,
		existingCookie: string | undefined,
		to?: string,
	): Promise<{ cookie: string; location: string } | null> {
		const srv = this.getServer(name, "app");
		if (!srv) return null;
		const cookie = await ensureDevSession(existingCookie);
		if (!cookie) return null;
		const host = resolveHost();
		return {
			cookie,
			location: `http://${host}:${srv.port}${to ?? srv.spec.openPath}`,
		};
	}

	/**
	 * Refresh the shared origin/main, then check each worktree for merge
	 * conflicts with main using `git merge-tree` — an in-memory 3-way merge that
	 * touches no working tree or index, so it's safe and cheap. Conflicts are
	 * symmetric, so this one check tells you whether merging main↔branch will
	 * conflict (i.e. whether "Merge main" is safe). Throttled to ~3 min.
	 */
	private async checkConflicts() {
		if (this.conflictBusy) {
			return;
		}
		const wts = [...this.worktrees.values()].filter((w) => w.branch !== "—");
		if (wts.length === 0) {
			return;
		}
		this.conflictBusy = true;
		try {
			const ref = wts[0];
			const def = this.defaultBranch(ref.path);
			// Refresh the shared origin/<def> over HTTPS (SSH has no key here).
			const slug = this.detectRepoSlug(ref.path);
			const token = process.env.GH_TOKEN;
			if (slug && token) {
				const url = `https://x-access-token:${token}@github.com/${slug.owner}/${slug.repo}.git`;
				Bun.spawnSync([
					"git",
					"-C",
					ref.path,
					"fetch",
					url,
					`+${def}:refs/remotes/origin/${def}`,
				]);
			}
			for (const wt of wts) {
				const r = Bun.spawnSync([
					"git",
					"-C",
					wt.path,
					"merge-tree",
					"--write-tree",
					wt.branch,
					`origin/${def}`,
				]);
				// 0 = clean merge, 1 = conflicts, anything else = couldn't tell.
				wt.conflict =
					r.exitCode === 0
						? "clean"
						: r.exitCode === 1
							? "conflict"
							: "unknown";
			}
		} finally {
			this.conflictBusy = false;
		}
	}

	loop() {
		const tick = async () => {
			try {
				this.discover();
				await this.health();
				if (Date.now() - this.conflictAt > 180_000) {
					this.conflictAt = Date.now();
					void this.checkConflicts();
				}
				// Matches the PR cache TTL: "I just merged, clean it up" should not
				// wait three minutes.
				if (Date.now() - this.mergedAt > 60_000) {
					this.mergedAt = Date.now();
					void this.sweepMerged();
				}
				if (Date.now() - this.envSweepAt > 60_000) {
					this.envSweepAt = Date.now();
					this.sweepEnv();
				}
			} catch (e) {
				// One bad tick must not kill the interval and take the whole
				// dashboard's liveness with it.
				console.error("tick failed:", e);
			}
		};
		tick();
		setInterval(tick, RESCAN_MS);
	}

	shutdown() {
		for (const wt of this.worktrees.values()) {
			for (const id of wt.servers.keys()) {
				this.stop(wt.name, id);
			}
		}
	}
}
