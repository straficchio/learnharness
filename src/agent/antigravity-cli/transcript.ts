import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

export type AgyImage = { mimeType: string; data: string };

export type AgyInput = {
	systemPrompt: string;
	tools: Tool[];
	/** Image references are markers until the adapter writes the temp files. */
	userContent: string;
	images: AgyImage[];
};

const IMAGE_MARKER_PREFIX = "\u0001LH_IMAGE_";
const IMAGE_MARKER_SUFFIX = "\u0001";
const IMAGE_MARKER_RE = /\u0001LH_IMAGE_(\d+)\u0001/g;

function imageMarker(index: number): string {
	return `${IMAGE_MARKER_PREFIX}${index}${IMAGE_MARKER_SUFFIX}`;
}

/** Replace image markers with their absolute temp-file paths. */
export function renderAgyContent(content: string, paths: readonly string[]): string {
	return content.replace(IMAGE_MARKER_RE, (_match, rawIndex: string) => {
		const path = paths[Number(rawIndex)];
		return path ?? "[image unavailable]";
	});
}

type ReplayState = { images: AgyImage[] };

function imagePart(image: ImageContent, state: ReplayState): string {
	const index = state.images.length;
	state.images.push({ mimeType: image.mimeType, data: image.data });
	return `[image: ${imageMarker(index)}]`;
}

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[], state: ReplayState): string[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image").map((block) => imagePart(block, state));

	return [text ? `${label}\n${text}` : label, ...images];
}

function getReplayParts(message: Message, state: ReplayState): string[] {
	switch (message.role) {
		case "system":
			return [];

		case "user":
			return getLabelledParts("[user]", message.content, state);

		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`[assistant]\n${block.text}`];
				if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
				return [];
			});

		case "toolResult": {
			const label = message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`;
			return getLabelledParts(label, message.content, state);
		}
	}
}

function toUnlabelledContent(content: string | (TextContent | ImageContent)[], state: ReplayState): string {
	if (typeof content === "string") return content;
	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image").map((block) => imagePart(block, state));
	return [text, ...images].filter(Boolean).join("\n");
}

export function toAgyInput(messages: Message[]): AgyInput {
	const conversation = messages.filter((message) => message.role !== "system");
	const state: ReplayState = { images: [] };
	const [first] = conversation;
	const userContent = conversation.length === 1 && first?.role === "user"
		? toUnlabelledContent(first.content, state)
		: conversation.flatMap((message) => getReplayParts(message, state)).filter(Boolean).join("\n\n");

	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages),
		userContent: state.images.length > 0
			? `${userContent}\n\n[Images are available at the local paths shown above. Use read_file or view_file on those paths before answering.]`
			: userContent,
		images: state.images,
	};
}

export function toAgyStreamJsonLine(content: string): string {
	return JSON.stringify({ event: "user", message: { content } });
}
