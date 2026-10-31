/**
 * Session sidebar selection — pure set helpers (tests pin the modifier-click
 * semantics without a DOM).
 */

export function toggleSelection(current: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(current);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

/** Drop selected ids that no longer exist in a refreshed list. Returns the
 *  same Set when nothing was pruned, so React can skip a needless render. */
export function pruneSelection(current: ReadonlySet<string>, existing: Iterable<string>): ReadonlySet<string> {
	const live = new Set(existing);
	if ([...current].every((id) => live.has(id))) return current;
	return new Set([...current].filter((id) => live.has(id)));
}

export function selectAllVisible(visible: Iterable<string>): Set<string> {
	return new Set(visible);
}

/** The bulk action bar appears only for a genuine multi-selection. */
export function hasBulkSelection(current: ReadonlySet<string>): boolean {
	return current.size >= 2;
}
