/**
 * Handler HTTP server: serves the dashboard, a JSON state API, control
 * endpoints (start/stop/restart per server or per worktree) and an SSE log
 * stream per server.
 */

import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import { Manager, SESSION_COOKIE, resolveHost } from "./manager.ts";

const HANDLER_PORT = Number(process.env.HANDLER_PORT ?? 47000);
const PUBLIC_DIR = join(import.meta.dir, "public");

const manager = new Manager();
manager.loop();

// Connected dashboards; state is pushed to them (no client polling / no full
// page refresh) so the UI patches in place and text stays selectable.
const clients = new Set<ServerWebSocket<unknown>>();

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const CONTENT_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
};

async function serveStatic(path: string): Promise<Response> {
	const file = Bun.file(join(PUBLIC_DIR, path));
	if (!(await file.exists())) {
		return new Response("not found", { status: 404 });
	}
	const ext = path.split(".").pop() ?? "";
	return new Response(file, {
		headers: {
			"content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
		},
	});
}

const server = Bun.serve({
	port: HANDLER_PORT,
	hostname: "0.0.0.0",
	idleTimeout: 0, // keep SSE + WS connections open
	async fetch(req, srv) {
		const url = new URL(req.url);
		const p = url.pathname;

		// ---- websocket: live state push ----
		if (p === "/ws") {
			if (srv.upgrade(req)) {
				return undefined;
			}
			return new Response("upgrade failed", { status: 400 });
		}

		// ---- static ----
		if (p === "/") {
			return serveStatic("index.html");
		}
		if (p === "/app.js" || p === "/styles.css") {
			return serveStatic(p.slice(1));
		}

		// ---- state ----
		if (p === "/api/state") {
			return json(manager.snapshot());
		}
		if (p === "/api/rescan" && req.method === "POST") {
			manager.discover();
			return json({ ok: true });
		}

		// ---- global actions across every worktree ----
		if (p === "/api/start-all" && req.method === "POST") {
			manager.startEverything();
			return json({ ok: true });
		}
		if (p === "/api/stop-all" && req.method === "POST") {
			manager.stopEverything();
			return json({ ok: true });
		}
		if (p === "/api/restart-all" && req.method === "POST") {
			manager.restartEverything();
			return json({ ok: true });
		}

		// ---- categories ----
		if (p === "/api/categories" && req.method === "POST") {
			const body = (await req.json().catch(() => ({}))) as { name?: unknown };
			if (typeof body.name === "string") {
				manager.createCategory(body.name);
			}
			return json({ ok: true });
		}
		let cm = p.match(/^\/api\/categories\/([^/]+)\/delete$/);
		if (cm && req.method === "POST") {
			manager.deleteCategory(decodeURIComponent(cm[1]));
			return json({ ok: true });
		}

		// ---- dev-login bootstrap: hand the browser a session cookie so
		// opening any worktree lands already authenticated (see ensureDevSession).
		// No Secure flag (plain-HTTP local dev) — the app's own cookie is
		// non-secure here too (ENVIRONMENT=development). ----
		if (p === "/api/dev-login" && req.method === "GET") {
			const name = url.searchParams.get("worktree") ?? "";
			const to = url.searchParams.get("to") ?? undefined;
			// The session cookie is host-only, and the worktree apps live
			// on the PUBLIC_HOST origin (e.g. main:51600) — a cookie set on the
			// dashboard's host (localhost) would never reach them. So bounce to
			// the same endpoint on the app host first, where the cookie is
			// actually valid, then redirect into the worktree.
			const wantHost = resolveHost();
			const reqHost = (req.headers.get("host") ?? "").split(":")[0];
			if (reqHost !== wantHost) {
				const q = new URLSearchParams({ worktree: name });
				if (to) q.set("to", to);
				return new Response(null, {
					status: 302,
					headers: {
						location: `http://${wantHost}:${HANDLER_PORT}/api/dev-login?${q}`,
					},
				});
			}
			const existing = req.headers
				.get("cookie")
				?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
			const r = await manager.devLogin(name, existing, to);
			if (!r) {
				return json({ error: "no app server for that worktree" }, 404);
			}
			return new Response(null, {
				status: 302,
				headers: {
					location: r.location,
					"set-cookie": `${SESSION_COOKIE}=${r.cookie}; Path=/; HttpOnly; SameSite=Lax`,
				},
			});
		}

		// ---- worktree-level actions: /api/worktrees/:name/:action ----
		let m = p.match(
			/^\/api\/worktrees\/([^/]+)\/(start|stop|restart|merge-main)$/,
		);
		if (m && req.method === "POST") {
			const name = decodeURIComponent(m[1]);
			if (m[2] === "start") {
				manager.startWorktree(name);
			} else if (m[2] === "stop") {
				manager.stopWorktree(name);
			} else if (m[2] === "merge-main") {
				manager.mergeMain(name);
			} else {
				manager.restartWorktree(name);
			}
			return json({ ok: true });
		}

		// ---- live "PR" link: reads the active branch from git at click time and
		// redirects to the existing PR (if any) or a "create PR" compare URL. ----
		m = p.match(/^\/api\/worktrees\/([^/]+)\/create-pr$/);
		if (m && req.method === "GET") {
			const r = await manager.resolvePrLink(decodeURIComponent(m[1]));
			if (!r.url) {
				return json(
					{ error: r.reason ?? "no PR link for this worktree" },
					400,
				);
			}
			return new Response(null, { status: 302, headers: { location: r.url } });
		}

		// ---- assign a worktree's category: /api/worktrees/:name/category ----
		cm = p.match(/^\/api\/worktrees\/([^/]+)\/category$/);
		if (cm && req.method === "POST") {
			const body = (await req.json().catch(() => ({}))) as {
				category?: unknown;
			};
			const cat = typeof body.category === "string" ? body.category : "";
			manager.setCategory(decodeURIComponent(cm[1]), cat);
			return json({ ok: true });
		}

		// ---- delete a worktree ----
		m = p.match(/^\/api\/worktrees\/([^/]+)\/delete$/);
		if (m && req.method === "POST") {
			const r = await manager.deleteWorktree(decodeURIComponent(m[1]));
			return json(r, r.ok ? 200 : 400);
		}

		// ---- remove a worktree whose work has landed (re-verified server-side) ----
		m = p.match(/^\/api\/worktrees\/([^/]+)\/remove-merged$/);
		if (m && req.method === "POST") {
			const r = await manager.removeMerged(decodeURIComponent(m[1]));
			return json(r, r.ok ? 200 : 400);
		}

		// ---- remove every merged worktree ----
		if (p === "/api/clean-merged" && req.method === "POST") {
			return json(await manager.cleanMerged());
		}

		// ---- setup (dependency install) ----
		m = p.match(/^\/api\/worktrees\/([^/]+)\/setup\/(reinstall|logs|stream)$/);
		if (m) {
			const wt = manager.getWorktree(decodeURIComponent(m[1]));
			if (!wt) {
				return json({ error: "no such worktree" }, 404);
			}
			if (m[2] === "reinstall" && req.method === "POST") {
				manager.reinstall(wt.name);
				return json({ ok: true });
			}
			if (m[2] === "logs") {
				return json({ lines: wt.setupLogs });
			}
			if (m[2] === "stream") {
				const enc = new TextEncoder();
				let listener: (line: {
					t: number;
					stream: string;
					text: string;
				}) => void;
				const stream = new ReadableStream({
					start(controller) {
						const send = (obj: unknown) => {
							try {
								controller.enqueue(
									enc.encode(`data: ${JSON.stringify(obj)}\n\n`),
								);
							} catch {}
						};
						for (const line of wt.setupLogs.slice(-300)) {
							send(line);
						}
						listener = (line) => send(line);
						wt.setupListeners.add(listener);
						req.signal.addEventListener("abort", () => {
							wt.setupListeners.delete(listener);
							try {
								controller.close();
							} catch {}
						});
					},
					cancel() {
						wt.setupListeners.delete(listener);
					},
				});
				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					},
				});
			}
		}

		// ---- server-level actions: /api/worktrees/:name/servers/:id/:action ----
		m = p.match(
			/^\/api\/worktrees\/([^/]+)\/servers\/([^/]+)\/(start|stop|restart)$/,
		);
		if (m && req.method === "POST") {
			const [, rawName, rawId, action] = m;
			const name = decodeURIComponent(rawName);
			const id = decodeURIComponent(rawId);
			if (!manager.getServer(name, id)) {
				return json({ error: "no such server" }, 404);
			}
			if (action === "start") {
				manager.start(name, id);
			} else if (action === "stop") {
				manager.stop(name, id);
			} else {
				manager.restart(name, id);
			}
			return json({ ok: true });
		}

		// ---- recent logs (snapshot) ----
		m = p.match(/^\/api\/worktrees\/([^/]+)\/servers\/([^/]+)\/logs$/);
		if (m) {
			const srv = manager.getServer(
				decodeURIComponent(m[1]),
				decodeURIComponent(m[2]),
			);
			if (!srv) {
				return json({ error: "no such server" }, 404);
			}
			return json({ lines: srv.logs });
		}

		// ---- live log stream (SSE) ----
		m = p.match(/^\/api\/worktrees\/([^/]+)\/servers\/([^/]+)\/stream$/);
		if (m) {
			const srv = manager.getServer(
				decodeURIComponent(m[1]),
				decodeURIComponent(m[2]),
			);
			if (!srv) {
				return new Response("no such server", { status: 404 });
			}
			const enc = new TextEncoder();
			let listener: (line: { t: number; stream: string; text: string }) => void;
			const stream = new ReadableStream({
				start(controller) {
					const send = (obj: unknown) => {
						try {
							controller.enqueue(
								enc.encode(`data: ${JSON.stringify(obj)}\n\n`),
							);
						} catch {}
					};
					// backfill recent history, then stream new lines
					for (const line of srv.logs.slice(-200)) {
						send(line);
					}
					listener = (line) => send(line);
					srv.listeners.add(listener);
					req.signal.addEventListener("abort", () => {
						srv.listeners.delete(listener);
						try {
							controller.close();
						} catch {}
					});
				},
				cancel() {
					srv.listeners.delete(listener);
				},
			});
			return new Response(stream, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				},
			});
		}

		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			clients.add(ws);
			ws.send(JSON.stringify(manager.snapshot()));
		},
		close(ws) {
			clients.delete(ws);
		},
		message() {},
	},
});

// Push state to all connected dashboards.
setInterval(() => {
	if (clients.size === 0) {
		return;
	}
	const payload = JSON.stringify(manager.snapshot());
	for (const ws of clients) {
		try {
			ws.send(payload);
		} catch {}
	}
}, 1000);

console.log(`worktree-handler listening on http://localhost:${server.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		console.log(`\n${sig} → stopping all dev servers…`);
		manager.shutdown();
		setTimeout(() => process.exit(0), 500);
	});
}
