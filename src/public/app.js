// Dashboard client. State arrives over a WebSocket and is patched into the DOM
// in place (no full re-render), so text stays selectable while it updates.
// Logs stream over SSE in the modal.

const $ = (sel) => document.querySelector(sel);
const worktreesEl = $("#worktrees");
const sublineEl = $("#subline");
const connEl = $("#conn");
const enc = encodeURIComponent;

let logSource = null;
let launcherUrl = ""; // host-side launcher base URL (from state)
let lastState = { worktrees: [] }; // latest snapshot, for header-button handlers

async function post(path) {
	await fetch(path, { method: "POST" });
}

async function postJson(path, body) {
	await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

// Ask the host launcher to open Ghostty + Claude Code in this worktree.
async function openClaude(name) {
	if (!launcherUrl) {
		return;
	}
	try {
		const r = await fetch(`${launcherUrl}/open?worktree=${enc(name)}`, {
			method: "POST",
		});
		if (!r.ok) {
			const e = await r.json().catch(() => ({}));
			alert(`Open Claude failed: ${e.error || r.status}`);
		}
	} catch {
		alert(
			"Couldn't reach the Claude launcher.\n\nStart it on your machine (in your desktop session):\n  cd handler && bun run launcher",
		);
	}
}

// ---- categories ----
const NEW_CATEGORY = "__new__";

// Assign a worktree to a category. The "+ New category…" option prompts for a
// name. The next state push corrects the <select> to the persisted value.
async function setCategory(name, value, selectEl) {
	let category = value;
	if (category === NEW_CATEGORY) {
		category = (prompt(`New category for “${name}”:`) || "").trim();
		if (!category) {
			selectEl.value = selectEl.dataset.current || "";
			return;
		}
	}
	await postJson(`/api/worktrees/${enc(name)}/category`, { category });
}

// Rebuild a card's category <select> only when the category list changes
// (keeps focus/selection stable), then point it at the worktree's category.
function syncCatSelect(sel, cats, current) {
	const sig = JSON.stringify(cats);
	if (sel.dataset.sig !== sig) {
		sel.dataset.sig = sig;
		sel.replaceChildren();
		sel.append(new Option("Uncategorized", ""));
		for (const c of cats) {
			sel.append(new Option(c, c));
		}
		sel.append(new Option("＋ New category…", NEW_CATEGORY));
	}
	if (current && !cats.includes(current)) {
		sel.append(new Option(current, current));
	}
	sel.dataset.current = current || "";
	if (sel.value !== (current || "")) {
		sel.value = current || "";
	}
}

function el(tag, props = {}, children = []) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") {
			e.className = v;
		} else if (k === "html") {
			e.innerHTML = v;
		} else if (k.startsWith("on")) {
			e.addEventListener(k.slice(2), v);
		} else if (v !== null && v !== undefined) {
			e.setAttribute(k, v);
		}
	}
	for (const c of [].concat(children)) {
		if (c !== null && c !== undefined && c !== false) {
			e.append(c.nodeType ? c : document.createTextNode(c));
		}
	}
	return e;
}

function setText(node, text) {
	if (node.textContent !== text) {
		node.textContent = text;
	}
}
function setClass(node, cls) {
	if (node.className !== cls) {
		node.className = cls;
	}
}
function setAttr(node, name, val) {
	if (node.getAttribute(name) !== val) {
		node.setAttribute(name, val);
	}
}

// ---- clipboard (works on http LAN access too, not just secure contexts) ----
function copyText(text) {
	if (navigator.clipboard && window.isSecureContext) {
		return navigator.clipboard.writeText(text);
	}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.top = "-1000px";
	ta.style.opacity = "0";
	document.body.append(ta);
	ta.focus();
	ta.select();
	try {
		document.execCommand("copy");
	} catch {}
	ta.remove();
	return Promise.resolve();
}

// ---- card cache: name -> refs (built once, then patched) ----
const cards = new Map();
// ---- category group cache: category key ("" = uncategorized) -> refs ----
const groups = new Map();

// Ensure a category section exists; built once, then reused/repositioned.
function ensureGroup(key) {
	let grp = groups.get(key);
	if (grp) {
		return grp;
	}
	const nameEl = el("span", { class: "cat-name" });
	const countEl = el("span", { class: "cat-count" });
	const headChildren = [nameEl, countEl, el("span", { class: "spacer" })];
	if (key) {
		headChildren.push(
			el(
				"button",
				{
					class: "btn cat-del",
					title: "Remove this category (its worktrees become Uncategorized)",
					onclick: () =>
						openConfirm(
							`Remove category “${key}”?`,
							`Worktrees in “${key}” move to Uncategorized. The worktrees, branches and servers are not affected.`,
							"Remove category",
							() => post(`/api/categories/${enc(key)}/delete`),
						),
				},
				"✕",
			),
		);
	}
	const header = el("div", { class: "cat-header" }, headChildren);
	const body = el("div", { class: "cat-cards" });
	const section = el("section", { class: "cat-group" }, [header, body]);
	grp = { section, body, nameEl, countEl };
	groups.set(key, grp);
	return grp;
}

function buildCard(wt) {
	const branchEl = el("code", {
		class: "branch",
		title: "click to copy branch name",
		onclick: () => {
			copyText(branchEl.dataset.branch || "");
			const prev = branchEl.textContent;
			branchEl.classList.add("copied");
			branchEl.textContent = "copied ✓";
			setTimeout(() => {
				branchEl.textContent = prev;
				branchEl.classList.remove("copied");
			}, 900);
		},
	});
	const portsEl = el("span", { class: "ports" });
	const statusPill = el("span", { class: "wt-status" });
	const mergedBadge = el(
		"span",
		{
			class: "merged-badge hidden",
			title: "This branch's PR was merged",
		},
		"✓ merged",
	);
	const removableBadge = el(
		"span",
		{
			class: "removable-badge hidden",
			title: "Merged with nothing local-only — safe to remove",
		},
		"✓ safe to remove",
	);
	const prBadge = el("span", { class: "pr-badge hidden" });
	const conflictBadge = el("span", { class: "conflict-badge hidden" });
	const prLink = el(
		"a",
		{ class: "btn pr", target: "_blank", rel: "noopener" },
		"PR",
	);
	const mergeBtn = el(
		"button",
		{
			class: "btn",
			title: "Fetch & merge main into this branch",
			onclick: () => post(`/api/worktrees/${enc(wt.name)}/merge-main`),
		},
		"⤓ Merge main",
	);
	const claudeBtn = el(
		"button",
		{
			class: "btn claude",
			title: "Open Claude Code in this worktree (Ghostty)",
			onclick: () => openClaude(wt.name),
		},
		"⌨ Claude",
	);
	const catSelect = el("select", {
		class: "cat-select",
		title: "Assign a category",
		onchange: (e) => setCategory(wt.name, e.target.value, catSelect),
	});
	const head = el("div", { class: "card-head" }, [
		el("div", { class: "wt-name-row" }, [
			el("span", { class: "wt-name" }, wt.name),
			statusPill,
			mergedBadge,
			removableBadge,
			prBadge,
			conflictBadge,
		]),
		el("div", { class: "wt-meta" }, [branchEl, portsEl]),
		el("div", { class: "wt-cat-row" }, [
			el("span", { class: "wt-cat-label" }, "Category"),
			catSelect,
		]),
	]);
	const deleteBtn = el(
		"button",
		{
			class: "btn danger",
			title: "Delete this worktree folder",
			onclick: () =>
				openConfirm(
					`Delete worktree “${wt.name}”?`,
					`This permanently removes the folder:\n${wt.path}\n\nRuns \`git worktree remove --force\` — any uncommitted changes and node_modules in it are deleted. The git branch itself is kept. This cannot be undone.`,
					"Delete worktree",
					async () => {
						const r = await fetch(`/api/worktrees/${enc(wt.name)}/delete`, {
							method: "POST",
						});
						if (!r.ok) {
							const e = await r.json().catch(() => ({}));
							alert(`Delete failed: ${e.error || r.status}`);
						}
					},
				),
		},
		"🗑 Delete",
	);
	const removeBtn = el(
		"button",
		{
			class: "btn ok hidden",
			title: "Merged with nothing local-only — remove this worktree and its branch",
			onclick: () =>
				openConfirm(
					`Remove worktree “${wt.name}”?`,
					`Its PR merged into ${wt.removableBase} and it has no uncommitted or unpushed work.\n\nThis deletes the folder:\n${wt.path}\n\nAND its local git branch “${wt.branch}”. The commits are in ${wt.removableBase}, but the branch ref is not recoverable. Re-verified before deleting.`,
					"Remove worktree",
					async () => {
						const r = await fetch(
							`/api/worktrees/${enc(wt.name)}/remove-merged`,
							{ method: "POST" },
						);
						if (!r.ok) {
							const e = await r.json().catch(() => ({}));
							alert(`Remove failed: ${e.error || r.status}`);
						}
					},
				),
		},
		"✓ Remove",
	);
	const actions = el("div", { class: "card-actions" }, [
		prLink,
		mergeBtn,
		claudeBtn,
		el("span", { class: "spacer" }),
		el(
			"button",
			{
				class: "btn",
				onclick: () => post(`/api/worktrees/${enc(wt.name)}/start`),
			},
			"Start all",
		),
		el(
			"button",
			{
				class: "btn danger",
				onclick: () => post(`/api/worktrees/${enc(wt.name)}/stop`),
			},
			"Stop all",
		),
		el(
			"button",
			{
				class: "btn icon",
				title: "Restart all",
				onclick: () => post(`/api/worktrees/${enc(wt.name)}/restart`),
			},
			"↻",
		),
		!wt.isMain && removeBtn,
		!wt.isMain && deleteBtn,
	]);

	const serversEl = el("div", { class: "servers" });
	const serverRefs = new Map();
	for (const s of wt.servers) {
		const dot = el("span", { class: "dot" });
		const label = el("div", { class: "server-label" }, s.label);
		const sub = el("div", { class: "server-sub" });
		const open = el(
			"a",
			{ class: "btn open", target: "_blank", rel: "noopener" },
			"Open ↗",
		);
		const action = el("button", { class: "btn" });
		const restart = el(
			"button",
			{
				class: "btn",
				title: "Restart",
				onclick: () =>
					post(`/api/worktrees/${enc(wt.name)}/servers/${s.id}/restart`),
			},
			"↻",
		);
		const logs = el(
			"button",
			{
				class: "btn",
				title: "Logs",
				onclick: () => openLogs(wt.name, s.id, `${wt.name} · ${s.label}`),
			},
			"Logs",
		);
		const row = el("div", { class: "server" }, [
			dot,
			el("div", { class: "server-main" }, [label, sub]),
			el("div", { class: "server-actions" }, [open, logs, action, restart]),
		]);
		serversEl.append(row);
		serverRefs.set(s.id, { dot, sub, open, action, mode: null });
	}

	const setupText = el("span", { class: "setup-text" });
	const setupRetryBtn = el(
		"button",
		{
			class: "btn",
			onclick: () => post(`/api/worktrees/${enc(wt.name)}/setup/reinstall`),
		},
		"Retry install",
	);
	const setupBanner = el("div", { class: "setup-banner hidden" }, [
		el("span", { class: "setup-spinner" }),
		setupText,
		el("span", { class: "spacer" }),
		el(
			"button",
			{
				class: "btn",
				onclick: () =>
					openSetupLogs(wt.name, `${wt.name} · dependency install`),
			},
			"Logs",
		),
		setupRetryBtn,
	]);

	const root = el("div", { class: "card" }, [
		head,
		actions,
		setupBanner,
		serversEl,
	]);
	return {
		root,
		branchEl,
		portsEl,
		prLink,
		statusPill,
		mergedBadge,
		removableBadge,
		removeBtn,
		prBadge,
		conflictBadge,
		mergeBtn,
		setupBanner,
		setupText,
		setupRetryBtn,
		serverRefs,
		catSelect,
	};
}

function patchServer(refs, wt, s) {
	setClass(refs.dot, `dot ${s.status}`);
	setAttr(refs.dot, "title", s.status);

	const status = s.status.charAt(0).toUpperCase() + s.status.slice(1);
	let sub = `${status} · :${s.port}`;
	if (s.pid) {
		sub += ` · pid ${s.pid}`;
	}
	if (s.status === "crashed" && s.exitCode != null) {
		sub += ` · exit ${s.exitCode}`;
	}
	setText(refs.sub, sub);

	setAttr(refs.open, "href", s.url);
	setAttr(refs.open, "title", s.url);
	setClass(refs.open, `btn open ${s.status === "running" ? "primary" : ""}`);

	const running = s.status === "running" || s.status === "starting";
	const mode = running ? "stop" : "start";
	if (refs.mode !== mode) {
		refs.mode = mode;
		refs.action.textContent = running ? "Stop" : "Start";
		setClass(refs.action, running ? "btn danger" : "btn");
		refs.action.onclick = () =>
			post(`/api/worktrees/${enc(wt.name)}/servers/${s.id}/${mode}`);
	}
}

// Apply all per-card state (badges, servers, category select, …).
function patchCard(c, wt, cats) {
	c.branchEl.dataset.branch = wt.branch;
	if (!c.branchEl.classList.contains("copied")) {
		setText(c.branchEl, wt.branch);
	}
	setText(c.portsEl, `:${wt.base}–${wt.base + 4}`);

	syncCatSelect(c.catSelect, cats, wt.category || "");

	const up = wt.servers.filter((s) => s.status === "running").length;
	const tot = wt.servers.length;
	setText(c.statusPill, `${up}/${tot} up`);
	setClass(
		c.statusPill,
		`wt-status ${up === tot ? "all" : up === 0 ? "none" : "some"}`,
	);

	c.mergedBadge.classList.toggle("hidden", !wt.merged);
	if (wt.merged) {
		setAttr(c.mergedBadge, "title", `PR merged into ${wt.prBase || "a long-lived branch"}`);
	}
	// A merged worktree we are NOT willing to remove says why, so the reason is
	// visible instead of the worktree just silently never being cleaned.
	if (wt.removable) {
		setText(c.removableBadge, "✓ safe to remove");
		setClass(c.removableBadge, "removable-badge");
		setAttr(c.removableBadge, "title", "Merged with nothing local-only");
	} else if (wt.prState === "merged" && wt.removableReason) {
		setText(c.removableBadge, `⚠ kept: ${wt.removableReason}`);
		setClass(c.removableBadge, "removable-badge blocked");
		setAttr(c.removableBadge, "title", wt.removableReason);
	} else {
		setClass(c.removableBadge, "removable-badge hidden");
	}
	c.removeBtn.classList.toggle("hidden", !wt.removable);

	// open-PR + CI badge
	if (wt.prState === "open") {
		const ci =
			{ passing: " · CI ✓", failing: " · CI ✗", pending: " · CI ⏳", none: "" }[
				wt.ci
			] || "";
		setText(c.prBadge, `PR #${wt.prNumber}${ci}`);
		setClass(c.prBadge, `pr-badge open ci-${wt.ci}`);
	} else if (wt.prState === "closed") {
		setText(c.prBadge, `PR #${wt.prNumber} closed`);
		setClass(c.prBadge, "pr-badge closed");
	} else {
		setClass(c.prBadge, "pr-badge hidden");
	}

	// conflict-with-main badge (so you know if Merge main is safe)
	if (wt.conflict === "conflict") {
		setText(c.conflictBadge, "⚠ conflicts with main");
		setClass(c.conflictBadge, "conflict-badge conflict");
	} else if (wt.conflict === "clean") {
		setText(c.conflictBadge, "✓ no conflicts");
		setClass(c.conflictBadge, "conflict-badge clean");
	} else {
		setClass(c.conflictBadge, "conflict-badge hidden");
	}

	const conflict = wt.conflict === "conflict";
	c.mergeBtn.disabled = !!wt.merging;
	c.mergeBtn.textContent = wt.merging ? "⤓ Merging…" : "⤓ Merge main";
	c.mergeBtn.classList.toggle("warn", conflict && !wt.merging);
	c.mergeBtn.title = conflict
		? "Merging main will CONFLICT — you'll need to resolve it manually"
		: "Fetch & merge main into this branch";

	if (wt.setup === "installing") {
		setClass(c.setupBanner, "setup-banner installing");
		setText(c.setupText, "Installing dependencies (bun install)…");
		c.setupRetryBtn.style.display = "none";
	} else if (wt.setup === "failed") {
		setClass(c.setupBanner, "setup-banner failed");
		setText(c.setupText, "Dependency install failed — servers not started");
		c.setupRetryBtn.style.display = "";
	} else if (wt.merging) {
		setClass(c.setupBanner, "setup-banner installing");
		setText(c.setupText, "Merging main into this branch…");
		c.setupRetryBtn.style.display = "none";
	} else if (wt.mergeFailed) {
		setClass(c.setupBanner, "setup-banner failed");
		setText(
			c.setupText,
			"Merge from main failed — resolve in the worktree (see logs)",
		);
		c.setupRetryBtn.style.display = "none";
	} else {
		setClass(c.setupBanner, "setup-banner hidden");
	}

	if (wt.prUrl) {
		// Click goes through the live endpoint, which re-reads the worktree's
		// active branch from git at click time (not this cached prUrl) and
		// redirects to the existing PR or a "create PR" compare URL.
		setAttr(c.prLink, "href", `/api/worktrees/${enc(wt.name)}/create-pr`);
		if (wt.prNumber) {
			setAttr(c.prLink, "title", `Open PR #${wt.prNumber}`);
			setText(c.prLink, `PR #${wt.prNumber} ↗`);
		} else {
			setAttr(c.prLink, "title", `Create PR from active branch (${wt.branch})`);
			setText(c.prLink, `PR → ${wt.prBase}`);
		}
		c.prLink.style.display = "";
	} else {
		c.prLink.style.display = "none";
	}
	for (const s of wt.servers) {
		const refs = c.serverRefs.get(s.id);
		if (refs) {
			patchServer(refs, wt, s);
		}
	}
}

function patch(state) {
	lastState = state;
	launcherUrl = state.launcher || "";
	const cats = state.categories || [];
	const removable = state.worktrees.filter((wt) => wt.removable).length;
	const cleanBtn = $("#clean-merged");
	cleanBtn.textContent = `🧹 Clean up ${removable} merged`;
	cleanBtn.disabled = removable === 0;
	const running = state.worktrees.reduce(
		(n, wt) => n + wt.servers.filter((s) => s.status === "running").length,
		0,
	);
	const total = state.worktrees.reduce((n, wt) => n + wt.servers.length, 0);
	setText(
		sublineEl,
		`${state.worktrees.length} worktrees · ${running}/${total} servers running · open via ${state.host}`,
	);

	// Bucket worktrees by category ("" = uncategorized), newest-created first so
	// the worktree you just made is at the top. Ports are irrelevant to order —
	// a re-added worktree takes the lowest free port and would jump around.
	// Ties (or an unknown creation time) fall back to name for a stable order.
	const sorted = [...state.worktrees].sort(
		(a, b) =>
			(b.createdAt || 0) - (a.createdAt || 0) || a.name.localeCompare(b.name),
	);
	const members = new Map();
	for (const wt of sorted) {
		const key = wt.category || "";
		if (!members.has(key)) {
			members.set(key, []);
		}
		members.get(key).push(wt);
	}

	// Group order: Uncategorized first — a newly created worktree is unassigned,
	// so its card is the first thing on the page — then the categories, keeping
	// known ones (even when empty) in their declared order.
	const order = [];
	if (members.has("")) {
		order.push("");
	}
	for (const key of cats) {
		if (key && !order.includes(key)) {
			order.push(key);
		}
	}
	for (const key of members.keys()) {
		if (key && !order.includes(key)) {
			order.push(key);
		}
	}

	const seenCards = new Set();
	const seenGroups = new Set();
	let prevSection = null;

	for (const key of order) {
		seenGroups.add(key);
		const grp = ensureGroup(key);
		const afterS = prevSection
			? prevSection.nextSibling
			: worktreesEl.firstChild;
		if (afterS !== grp.section) {
			worktreesEl.insertBefore(grp.section, afterS);
		}
		prevSection = grp.section;

		const mem = members.get(key) || [];
		setText(grp.nameEl, key || "Uncategorized");
		setText(grp.countEl, String(mem.length));

		let prevCard = null;
		for (const wt of mem) {
			seenCards.add(wt.name);
			let c = cards.get(wt.name);
			// Rebuild the card if its set of servers changed (e.g. a server was added).
			const sig = wt.servers.map((s) => s.id).join(",");
			if (c && c.sig !== sig) {
				c.root.remove();
				cards.delete(wt.name);
				c = null;
			}
			if (!c) {
				c = buildCard(wt);
				c.sig = sig;
				cards.set(wt.name, c);
			}
			// keep DOM order within the group matching member order
			const afterC = prevCard ? prevCard.nextSibling : grp.body.firstChild;
			if (afterC !== c.root) {
				grp.body.insertBefore(c.root, afterC);
			}
			prevCard = c.root;

			patchCard(c, wt, cats);
		}
	}

	// drop groups that no longer exist (category deleted / emptied)
	for (const [key, grp] of groups) {
		if (!seenGroups.has(key)) {
			grp.section.remove();
			groups.delete(key);
		}
	}
	// drop cards for removed worktrees
	for (const [name, c] of cards) {
		if (!seenCards.has(name)) {
			c.root.remove();
			cards.delete(name);
		}
	}

	const empty = $("#empty");
	if (order.length === 0 && !empty) {
		worktreesEl.append(
			el(
				"div",
				{ id: "empty", class: "empty" },
				"No worktrees found yet. Create one next to the handler.",
			),
		);
	} else if (order.length > 0 && empty) {
		empty.remove();
	}
}

// ---- websocket transport ----
let ws = null;
let reconnectTimer = null;

function connect() {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	ws = new WebSocket(`${proto}://${location.host}/ws`);
	ws.onopen = () => {
		connEl.textContent = "live";
		connEl.className = "pill pill-ok";
	};
	ws.onmessage = (ev) => {
		try {
			patch(JSON.parse(ev.data));
		} catch (e) {
			console.error(e);
		}
	};
	ws.onclose = () => {
		connEl.textContent = "reconnecting…";
		connEl.className = "pill pill-bad";
		if (!reconnectTimer) {
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				connect();
			}, 1500);
		}
	};
	ws.onerror = () => ws.close();
}

// ---- logs modal (SSE) ----
const modal = $("#log-modal");
const logBody = $("#log-body");
const logTitle = $("#log-title");
const autoscroll = $("#autoscroll");

function fmtLine(line) {
	const ts = new Date(line.t).toLocaleTimeString();
	return el("span", {}, [
		el("span", { class: "ts" }, ts),
		el("span", { class: line.stream }, `${line.text}\n`),
	]);
}

function streamLogs(url, title) {
	logTitle.textContent = title;
	logBody.innerHTML = "";
	modal.classList.remove("hidden");
	if (logSource) {
		logSource.close();
	}
	logSource = new EventSource(url);
	logSource.onmessage = (ev) => {
		const line = JSON.parse(ev.data);
		// Server signals a restart clear: wipe the view so only logs since the
		// latest restart remain.
		if (line.clear) {
			logBody.innerHTML = "";
			return;
		}
		logBody.append(fmtLine(line));
		if (autoscroll.checked) {
			logBody.scrollTop = logBody.scrollHeight;
		}
	};
}

function openLogs(name, id, title) {
	streamLogs(`/api/worktrees/${enc(name)}/servers/${id}/stream`, title);
}

function openSetupLogs(name, title) {
	streamLogs(`/api/worktrees/${enc(name)}/setup/stream`, title);
}

function closeLogs() {
	modal.classList.add("hidden");
	if (logSource) {
		logSource.close();
		logSource = null;
	}
}

$("#log-copy").addEventListener("click", () => {
	copyText(logBody.innerText || logBody.textContent || "");
	const b = $("#log-copy");
	const prev = b.textContent;
	b.textContent = "Copied ✓";
	setTimeout(() => {
		b.textContent = prev;
	}, 900);
});
$("#log-close").addEventListener("click", closeLogs);
modal.addEventListener("click", (e) => {
	if (e.target === modal) {
		closeLogs();
	}
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !modal.classList.contains("hidden")) {
		closeLogs();
	}
});
$("#rescan").addEventListener("click", () => post("/api/rescan"));
$("#start-all").addEventListener("click", () => post("/api/start-all"));
$("#stop-all").addEventListener("click", () => post("/api/stop-all"));

$("#clean-merged").addEventListener("click", () => {
	const eligible = lastState.worktrees.filter((w) => w.removable);
	if (eligible.length === 0) return;
	// The server re-verifies every worktree before removing it, so this list is
	// informational only — a stale snapshot can under-report, never over-delete.
	const blocked = lastState.worktrees.filter(
		(w) => w.prState === "merged" && !w.removable && w.removableReason,
	);
	const willGo = eligible
		.map((w) => `  ${w.name} — PR #${w.prNumber} → ${w.removableBase}`)
		.join("\n");
	const wontGo = blocked
		.map((w) => `  ${w.name} — ${w.removableReason}`)
		.join("\n");
	openConfirm(
		`Remove ${eligible.length} worktree${eligible.length === 1 ? "" : "s"}?`,
		`This deletes each folder below AND its local git branch. The commits are already in ` +
			`${[...new Set(eligible.map((w) => w.removableBase))].join(", ")}, but the branch refs are not recoverable. ` +
			`Each one is re-checked immediately before deletion.\n\nWILL REMOVE\n${willGo}` +
			(wontGo ? `\n\nWILL SKIP\n${wontGo}` : ""),
		`Remove ${eligible.length}`,
		async () => {
			const r = await fetch("/api/clean-merged", { method: "POST" });
			const res = await r.json().catch(() => ({}));
			if (res.failed && res.failed.length > 0) {
				alert(
					`Removed ${res.removed.length}, but ${res.failed.length} failed:\n` +
						res.failed.map((f) => `${f.name}: ${f.error}`).join("\n"),
				);
			}
		},
	);
});
$("#new-cat").addEventListener("click", async () => {
	const name = (prompt("New category name:") || "").trim();
	if (name) {
		await postJson("/api/categories", { name });
	}
});

// ---- confirm modal (reusable) ----
let confirmCb = null;
const confirmModal = $("#confirm-modal");
function openConfirm(title, message, okLabel, cb) {
	$("#confirm-title").textContent = title;
	$("#confirm-message").textContent = message;
	$("#confirm-ok").textContent = okLabel || "Confirm";
	confirmCb = cb;
	confirmModal.classList.remove("hidden");
}
function closeConfirm() {
	confirmModal.classList.add("hidden");
	confirmCb = null;
}
$("#confirm-cancel").addEventListener("click", closeConfirm);
$("#confirm-ok").addEventListener("click", () => {
	const cb = confirmCb;
	closeConfirm();
	if (cb) {
		cb();
	}
});
confirmModal.addEventListener("click", (e) => {
	if (e.target === confirmModal) {
		closeConfirm();
	}
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !confirmModal.classList.contains("hidden")) {
		closeConfirm();
	}
});

connect();
