/**
 * Host-side launcher — run this OUTSIDE Docker, in your desktop session
 * (it needs your graphical environment to open Ghostty):
 *
 *     cd handler && bun run launcher        # or: bun run launcher.ts
 *
 * It exposes a tiny localhost endpoint the dashboard's "Open Claude" button
 * calls, and opens Ghostty running `claude` in the chosen worktree. The handler
 * container can't do this itself — a container can't spawn host GUI processes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.WORKSPACE_ROOT ?? join(process.env.HOME ?? "", "programing");
const PORT = Number(process.env.LAUNCHER_PORT ?? 48010);

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET,POST,OPTIONS",
	"access-control-allow-headers": "*",
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", ...CORS },
	});
}

const server = Bun.serve({
	port: PORT,
	hostname: "127.0.0.1", // host-only; Ghostty opens on this machine's display
	fetch(req) {
		const url = new URL(req.url);
		if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
		if (url.pathname === "/health") return json({ ok: true, root: ROOT });

		if (url.pathname === "/open") {
			const name = url.searchParams.get("worktree") ?? "";
			// Only a single, safe path segment — no traversal / injection.
			if (!name || name.includes("/") || name.includes("..") || name.startsWith(".")) {
				return json({ error: "invalid worktree name" }, 400);
			}
			const dir = join(ROOT, name);
			if (!existsSync(dir)) return json({ error: `no such worktree: ${dir}` }, 404);

			// Open Ghostty in the worktree dir and run Claude Code. A login shell
			// ensures ~/.local/bin (claude) is on PATH; exec replaces the shell so
			// closing Claude closes the window.
			const cmd = `cd ${shq(dir)} && exec claude`;
			const proc = spawn("ghostty", ["--working-directory=" + dir, "-e", "bash", "-lc", cmd], {
				detached: true,
				stdio: "ignore",
				env: process.env,
			});
			proc.on("error", (e) => console.error("failed to launch ghostty:", e.message));
			proc.unref();
			console.log(`opened Claude in ${dir}`);
			return json({ ok: true, dir });
		}
		return json({ error: "not found" }, 404);
	},
});

function shq(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

console.log(`claude launcher listening on http://127.0.0.1:${server.port} (root: ${ROOT})`);
