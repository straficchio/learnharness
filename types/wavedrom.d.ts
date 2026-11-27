declare module "wavedrom" {
	export interface WaveSkin {
		[key: string]: unknown;
	}
	export function renderWaveElement(
		index: number,
		source: Record<string, unknown>,
		output: HTMLElement,
		skin?: WaveSkin,
		notFirstSignal?: boolean,
		notFirstAssign?: boolean,
	): void;
	export const waveSkin: WaveSkin;
}
