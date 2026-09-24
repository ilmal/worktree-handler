// Handler-injected Vite config override — LOCAL DEV ONLY.
//
// Vite 5.4 blocks any request whose Host header isn't in `server.allowedHosts`
// (e.g. a Tailscale MagicDNS name), so the dashboard's hostname-based
// "Open" links get a 403. This override merges `allowedHosts: true` into the
// worktree's OWN vite.config.js (path passed via VITE_BASE_CONFIG_ABS) without
// touching the app repo's file — so nothing here is pushed to the app remote.
//
// Loaded via `vite dev --config <this file>`; Vite does not auto-detect the
// worktree's vite.config.js when --config is given, so the base config is pulled
// in explicitly and merged.
const baseConfig = (await import(process.env.VITE_BASE_CONFIG_ABS)).default;
const base =
	typeof baseConfig === "function"
		? await baseConfig({ mode: "development", command: "serve" })
		: baseConfig;

export default {
	...base,
	server: { ...(base.server || {}), allowedHosts: true },
	preview: { ...(base.preview || {}), allowedHosts: true },
};