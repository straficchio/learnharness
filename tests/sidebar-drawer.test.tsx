/**
 * Sidebar drawer state machine: viewport-default pinning, the explicit pin
 * (persisted), the modal drawer, and the pre-pin localStorage migration.
 *
 * The provider is mounted with linkedom exactly like the other React tests;
 * the probe renders the four state facts and the three actions, so these
 * assertions never depend on the sidebar's full menu markup.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SidebarProvider, useSidebar } from "../components/sidebar.tsx";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
Object.defineProperty(dom.window, "innerWidth", { configurable: true, writable: true, value: 1400 });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => { store.set(key, String(value)); },
		removeItem: (key: string) => { store.delete(key); },
		clear: () => { store.clear(); },
	},
	requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let current: ReturnType<typeof useSidebar> | null = null;

function Probe() {
	const sidebar = useSidebar();
	current = sidebar;
	return (
		<div>
			<button data-testid="toggle" onClick={sidebar.toggle} />
			<button data-testid="pin" onClick={sidebar.togglePin} />
			<button data-testid="close" onClick={() => sidebar.close()} />
		</div>
	);
}

async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<SidebarProvider><Probe /></SidebarProvider>));
}

async function click(id: string) {
	await act(async () => {
		document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click();
	});
}

async function resize(width: number) {
	dom.window.innerWidth = width;
	await act(async () => {
		dom.window.dispatchEvent(new dom.window.Event("resize"));
	});
}

const snapshot = () => ({
	open: current!.open,
	pinned: current!.pinned,
	overlayOpen: current!.overlayOpen,
	narrow: current!.narrow,
});

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	current = null;
	store.clear();
	dom.window.innerWidth = 1400;
});

test("a wide viewport defaults to the pinned inline sidebar", async () => {
	await mount();
	assert.deepEqual(snapshot(), { open: true, pinned: true, overlayOpen: false, narrow: false });
	assert.equal(store.get("lh:sidebar-pinned"), undefined);
});

test("below 928 the default auto-unpins and hides, then opens as a modal drawer", async () => {
	await mount();
	await resize(800);
	assert.deepEqual(snapshot(), { open: false, pinned: false, overlayOpen: false, narrow: true });

	await click("toggle");
	assert.deepEqual(snapshot(), { open: true, pinned: false, overlayOpen: true, narrow: true });

	await click("close");
	assert.deepEqual(snapshot(), { open: false, pinned: false, overlayOpen: false, narrow: true });
});

test("escape closes the modal drawer", async () => {
	await mount();
	await resize(800);
	await click("toggle");
	assert.deepEqual(snapshot(), { open: true, pinned: false, overlayOpen: true, narrow: true });

	await act(async () => {
		const event = new dom.window.Event("keydown");
		Object.assign(event, { key: "Escape" });
		dom.window.dispatchEvent(event);
	});
	assert.deepEqual(snapshot(), { open: false, pinned: false, overlayOpen: false, narrow: true });
});

test("an explicit pin persists below the breakpoint and survives widening", async () => {
	await mount();
	await resize(800);
	await click("toggle");
	await click("pin");
	assert.deepEqual(snapshot(), { open: true, pinned: true, overlayOpen: false, narrow: true });
	assert.equal(store.get("lh:sidebar-pinned"), "1");

	await resize(1400);
	assert.deepEqual(snapshot(), { open: true, pinned: true, overlayOpen: false, narrow: false });
	await resize(800);
	assert.deepEqual(snapshot(), { open: true, pinned: true, overlayOpen: false, narrow: true });
});

test("unpinning keeps the drawer open as an overlay and the choice survives widening", async () => {
	await mount();
	await resize(800);
	await click("toggle");
	await click("pin");
	await click("pin");
	assert.deepEqual(snapshot(), { open: true, pinned: false, overlayOpen: true, narrow: true });
	assert.equal(store.get("lh:sidebar-pinned"), "0");

	await click("close");
	await resize(1400);
	assert.deepEqual(snapshot(), { open: false, pinned: false, overlayOpen: false, narrow: false });
});

test("the old manual-close preference migrates to an explicit unpin", async () => {
	store.set("lh:sidebar-open", "0");
	await mount();
	assert.deepEqual(snapshot(), { open: false, pinned: false, overlayOpen: false, narrow: false });
	assert.equal(store.get("lh:sidebar-pinned"), "0");
});

test("the old open preference follows the viewport default", async () => {
	store.set("lh:sidebar-open", "1");
	dom.window.innerWidth = 800;
	await mount();
	assert.deepEqual(snapshot(), { open: false, pinned: false, overlayOpen: false, narrow: true });
	assert.equal(store.get("lh:sidebar-pinned"), undefined);
});
