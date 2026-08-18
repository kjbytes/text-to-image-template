const IMAGE_COUNT = 10;
const FLUX_REF_LIMIT = 4; // ponytail: Workers AI Flux max is 4 refs; extras are vision-summarized. Upgrade: collage/resize into 4 tiles if Cloudflare Images is enabled.
const MAX_BYTES = 4_000_000;
const FETCH_MS = 15_000;
const MODEL = "@cf/black-forest-labs/flux-2-klein-9b";
const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

const cors = {
	"access-control-allow-origin": "*",
	"access-control-allow-headers": "content-type",
	"access-control-allow-methods": "GET, POST, OPTIONS",
};

export type GenerateInput = {
	prompt: string;
	images: string[];
	width?: number;
	height?: number;
};

export function isAllowedImageUrl(raw: string): boolean {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
		return false;
	}
	if (host.includes(":") && (host === "::1" || /^(fe80|fc|fd)/i.test(host))) {
		return false;
	}
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (m) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (a === 0 || a === 10 || a === 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
	}
	return true;
}

export function parseGenerateRequest(
	body: unknown,
): { ok: true; value: GenerateInput } | { ok: false; error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "JSON object body required" };
	}
	const { prompt, images, width, height } = body as Record<string, unknown>;
	if (typeof prompt !== "string" || !prompt.trim()) {
		return { ok: false, error: "prompt is required" };
	}
	if (!Array.isArray(images) || images.length !== IMAGE_COUNT) {
		return { ok: false, error: `images must be an array of ${IMAGE_COUNT} http(s) URLs` };
	}
	if (!images.every((u) => typeof u === "string" && isAllowedImageUrl(u))) {
		return { ok: false, error: "each image must be a public http(s) URL" };
	}
	const size = (n: unknown, name: string): number | undefined | { error: string } => {
		if (n === undefined) return undefined;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 256 || n > 1440) {
			return { error: `${name} must be an integer 256–1440` };
		}
		return n;
	};
	const w = size(width, "width");
	if (w && typeof w === "object") return { ok: false, error: w.error };
	const h = size(height, "height");
	if (h && typeof h === "object") return { ok: false, error: h.error };
	return {
		ok: true,
		value: {
			prompt: prompt.trim(),
			images: images as string[],
			width: w as number | undefined,
			height: h as number | undefined,
		},
	};
}

export function selfCheck(): void {
	const urls = Array.from({ length: IMAGE_COUNT }, (_, i) => `https://example.com/${i}.png`);
	const ok = parseGenerateRequest({ prompt: "a hero shot", images: urls });
	if (!ok.ok) throw new Error(ok.error);
	const empty = parseGenerateRequest({});
	if (empty.ok) throw new Error("empty body should fail");
	const nine = parseGenerateRequest({ prompt: "x", images: urls.slice(0, 9) });
	if (nine.ok) throw new Error("9 images should fail");
	const local = parseGenerateRequest({
		prompt: "x",
		images: ["http://127.0.0.1/a.png", ...urls.slice(1)],
	});
	if (local.ok) throw new Error("localhost URL should fail");
}

selfCheck();

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", ...cors },
	});
}

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function imageContentType(bytes: Uint8Array, fallback: string): string {
	if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
	if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
	return fallback.startsWith("image/") ? fallback : "image/jpeg";
}

type FetchedImage = { bytes: Uint8Array; type: string };

async function fetchImage(fetchImpl: typeof fetch, url: string): Promise<FetchedImage> {
	const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_MS), redirect: "follow" });
	if (!res.ok) throw new Error(`failed to fetch ${url} (${res.status})`);
	const type = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
	const buf = new Uint8Array(await res.arrayBuffer());
	if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
		throw new Error(`image at ${url} is empty or larger than ${MAX_BYTES} bytes`);
	}
	if (type && !type.startsWith("image/") && type !== "application/octet-stream") {
		throw new Error(`${url} is not an image`);
	}
	return { bytes: buf, type: imageContentType(buf, type || "image/jpeg") };
}

async function describeExtras(env: Env, extras: FetchedImage[], prompt: string): Promise<string> {
	if (extras.length === 0) return "";
	const content: Array<
		{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
	> = [
		{
			type: "text",
			text: `The user will generate a new image with this instruction: ${prompt}\nThese extra reference photos could not be attached as pixels. Describe their subjects, style, colors, and composition in one short paragraph to include in an image prompt. Reply with only that paragraph.`,
		},
	];
	for (const img of extras) {
		content.push({
			type: "image_url",
			image_url: { url: `data:${img.type};base64,${toBase64(img.bytes)}` },
		});
	}
	const out = await env.AI.run(VISION_MODEL, {
		messages: [{ role: "user", content }],
		max_tokens: 300,
	});
	return out.response?.trim() ?? "";
}

async function generate(env: Env, input: GenerateInput, images: FetchedImage[]): Promise<Uint8Array> {
	const refs = images.slice(0, FLUX_REF_LIMIT);
	const extras = images.slice(FLUX_REF_LIMIT);
	let extraText = "";
	try {
		extraText = await describeExtras(env, extras, input.prompt);
	} catch {
		// ponytail: vision extras are best-effort; 4 Flux refs still generate
	}

	const parts = [
		input.prompt,
		`Use image 0, image 1, image 2, and image 3 as visual references.`,
	];
	if (extraText) parts.push(`Also incorporate: ${extraText}`);

	const form = new FormData();
	form.append("prompt", parts.join("\n\n"));
	form.append("width", String(input.width ?? 1024));
	form.append("height", String(input.height ?? 1024));
	refs.forEach((img, i) => {
		form.append(`input_image_${i}`, new Blob([img.bytes], { type: img.type }), `ref${i}`);
	});

	const packed = new Response(form);
	const body = packed.body;
	if (!body) throw new Error("failed to serialize form");
	const out = (await env.AI.run(MODEL, {
		multipart: {
			body,
			contentType: packed.headers.get("content-type") ?? "multipart/form-data",
		},
	})) as { image?: string };
	if (!out.image) throw new Error("model returned no image");
	return fromBase64(out.image);
}

export async function handleRequest(
	request: Request,
	env: Env,
	fetchImpl: typeof fetch = fetch,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: cors });
	}

	if (request.method === "GET") {
		return json(200, {
			method: "POST",
			path: "/",
			body: {
				prompt: "string",
				images: `string[${IMAGE_COUNT}] http(s) image URLs`,
				width: "optional integer 256–1440",
				height: "optional integer 256–1440",
			},
			notes: [
				`Workers AI Flux accepts ${FLUX_REF_LIMIT} pixel references; the first ${FLUX_REF_LIMIT} URLs are used as those.`,
				`The remaining ${IMAGE_COUNT - FLUX_REF_LIMIT} are described and folded into the prompt.`,
			],
		});
	}

	if (request.method !== "POST") {
		return json(405, { error: "POST JSON { prompt, images[10] }" });
	}

	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		return json(400, { error: "invalid JSON" });
	}
	const req = parseGenerateRequest(parsed);
	if (!req.ok) return json(400, { error: req.error });

	let images: FetchedImage[];
	try {
		images = await Promise.all(req.value.images.map((url) => fetchImage(fetchImpl, url)));
	} catch (err) {
		return json(400, { error: err instanceof Error ? err.message : "failed to fetch images" });
	}

	try {
		const bytes = await generate(env, req.value, images);
		return new Response(bytes, {
			headers: { "content-type": imageContentType(bytes, "image/jpeg"), ...cors },
		});
	} catch (err) {
		return json(502, { error: err instanceof Error ? err.message : "generation failed" });
	}
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
