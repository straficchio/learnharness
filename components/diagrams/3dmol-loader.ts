import type { GLViewer } from "3dmol";

export interface ThreeDmol {
	createViewer(element: HTMLElement, config?: Record<string, unknown>): GLViewer;
}

declare global {
	interface Window {
		$3Dmol?: ThreeDmol;
	}
}

let loading: Promise<ThreeDmol> | null = null;

/** Load the minified 3Dmol UMD build from the app's public assets; cached for
 *  the page lifetime so a transcript with several viewers downloads it once. */
export function load3Dmol(): Promise<ThreeDmol> {
	if (typeof window === "undefined") return Promise.reject(new Error("3Dmol needs a browser"));
	if (window.$3Dmol) return Promise.resolve(window.$3Dmol);
	if (loading) return loading;
	loading = new Promise<ThreeDmol>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "/3dmol/3Dmol-min.js";
		script.async = true;
		script.onload = () => {
			if (window.$3Dmol) resolve(window.$3Dmol);
			else reject(new Error("3Dmol loaded without its viewer API."));
		};
		script.onerror = () => reject(new Error("Could not load the 3D structure renderer."));
		document.head.appendChild(script);
	}).catch((error: unknown) => {
		// A transient asset failure must not poison every later fence.
		loading = null;
		throw error;
	});
	return loading;
}
