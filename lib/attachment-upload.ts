/** One attachment upload (attachment wave). Kept outside the React
 *  component so the XHR progress contract can be tested in isolation. */
export interface UploadedAttachment {
	id: string;
	name: string;
	path: string;
	size: number;
}

export interface UploadProgress {
	loaded: number;
	total: number;
}

/** Upload one file. One request per file keeps multipart buffering bounded
 *  to the 50 MB per-file ceiling even when a message carries ten files.
 *  XHR (not fetch) because the attachment panel needs real byte progress. */
export function uploadAttachment(
	file: File,
	chatId?: string,
	onProgress?: (progress: UploadProgress) => void,
): Promise<UploadedAttachment> {
	return new Promise((resolve, reject) => {
		const form = new FormData();
		form.append("file", file);
		if (chatId) form.append("chatId", chatId);
		const request = new XMLHttpRequest();
		request.open("POST", "/api/attachments");
		request.upload.addEventListener("progress", (event) => {
			if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total });
		});
		// `progress` may stop just short of the final byte in some browsers.
		// The upload `load` event is the authoritative "bytes sent" boundary,
		// and lets the UI switch to its server-write ("Saving") phase.
		request.upload.addEventListener("load", () => onProgress?.({ loaded: file.size, total: file.size }));
		request.addEventListener("error", () => reject(new Error(`Could not attach ${file.name}. Check the connection and try again.`)));
		request.addEventListener("abort", () => reject(new Error(`Upload of ${file.name} was cancelled.`)));
		request.addEventListener("load", () => {
			let body: { attachment?: UploadedAttachment; error?: string } | null = null;
			try { body = JSON.parse(request.responseText) as { attachment?: UploadedAttachment; error?: string } | null; } catch { /* non-JSON failure below */ }
			if (request.status >= 200 && request.status < 300 && body?.attachment) resolve(body.attachment);
			else reject(new Error(body?.error ?? `Could not attach ${file.name}.`));
		});
		request.send(form);
	});
}
