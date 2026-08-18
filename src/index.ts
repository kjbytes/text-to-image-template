const IMAGE_COUNT = 10;
const FLUX_REF_LIMIT = 4; // Workers AI Flux.2 [dev] max pixel refs per call
const FLUX_FOLLOW_SLOTS = FLUX_REF_LIMIT - 1; // 1 slot is the previous result; 3 leftover source images per follow-up
const FLUX_INPUT_MAX = 512; // ponytail: Flux.2 [dev] input tiles are 512x512; intermediates used as next refs stay at 512. Upgrade: resize with Cloudflare Images.
const MAX_BYTES = 4_000_000;
const FETCH_MS = 15_000;
const MODEL = "@cf/black-forest-labs/flux-2-dev";

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
	if (images === undefined) {
		// prompt-only
	} else if (!Array.isArray(images) || images.length > IMAGE_COUNT) {
		return { ok: false, error: `images must be an array of 0–${IMAGE_COUNT} http(s) URLs` };
	} else if (!images.every((u) => typeof u === "string" && isAllowedImageUrl(u))) {
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
			images: Array.isArray(images) ? (images as string[]) : [],
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
	const none = parseGenerateRequest({ prompt: "x" });
	if (!none.ok) throw new Error(none.error);
	const nine = parseGenerateRequest({ prompt: "x", images: urls.slice(0, 9) });
	if (!nine.ok) throw new Error(nine.error);
	const eleven = parseGenerateRequest({ prompt: "x", images: [...urls, "https://example.com/x.png"] });
	if (eleven.ok) throw new Error("11 images should fail");
	const local = parseGenerateRequest({
		prompt: "x",
		images: ["http://127.0.0.1/a.png", ...urls.slice(1)],
	});
	if (local.ok) throw new Error("localhost URL should fail");
	if (fluxPassCount(0) !== 1 || fluxPassCount(4) !== 1) throw new Error("<=4 refs is one pass");
	if (fluxPassCount(6) !== 2) throw new Error("6 refs should be two Flux calls");
	if (fluxPassCount(10) !== 3) throw new Error("10 refs should be three Flux calls");
}

export function fluxPassCount(imageCount: number): number {
	if (imageCount <= FLUX_REF_LIMIT) return 1;
	return 1 + Math.ceil((imageCount - FLUX_REF_LIMIT) / FLUX_FOLLOW_SLOTS);
}

selfCheck();

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", ...cors },
	});
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

function refPrompt(userPrompt: string, refCount: number, followUp: boolean): string {
	if (refCount === 0) return userPrompt;
	const labels = Array.from({ length: refCount }, (_, i) => `image ${i}`).join(", ");
	if (!followUp) return `${userPrompt}\n\nUse ${labels} as visual references.`;
	const extra = Array.from({ length: refCount - 1 }, (_, i) => `image ${i + 1}`).join(", ");
	return `${userPrompt}\n\nImage 0 is the current result. Keep it as the base and incorporate ${extra} as additional visual references.`;
}

async function runFlux(
	env: Env,
	prompt: string,
	refs: FetchedImage[],
	width: number,
	height: number,
): Promise<Uint8Array> {
	const form = new FormData();
	form.append("prompt", prompt);
	form.append("width", String(width));
	form.append("height", String(height));
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

async function generate(env: Env, input: GenerateInput, images: FetchedImage[]): Promise<Uint8Array> {
	const width = input.width ?? 1024;
	const height = input.height ?? 1024;
	if (images.length <= FLUX_REF_LIMIT) {
		return runFlux(env, refPrompt(input.prompt, images.length, false), images, width, height);
	}

	const midW = Math.min(width, FLUX_INPUT_MAX);
	const midH = Math.min(height, FLUX_INPUT_MAX);
	let current = await runFlux(
		env,
		refPrompt(input.prompt, FLUX_REF_LIMIT, false),
		images.slice(0, FLUX_REF_LIMIT),
		midW,
		midH,
	);
	let rest = images.slice(FLUX_REF_LIMIT);
	while (rest.length > 0) {
		const batch = rest.slice(0, FLUX_FOLLOW_SLOTS);
		rest = rest.slice(FLUX_FOLLOW_SLOTS);
		const last = rest.length === 0;
		const refs: FetchedImage[] = [
			{ bytes: current, type: imageContentType(current, "image/jpeg") },
			...batch,
		];
		current = await runFlux(
			env,
			refPrompt(input.prompt, refs.length, true),
			refs,
			last ? width : midW,
			last ? height : midH,
		);
	}
	return current;
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
				images: `optional string[0–${IMAGE_COUNT}] http(s) image URLs`,
				width: "optional integer 256–1440",
				height: "optional integer 256–1440",
			},
			notes: [
				`Pass 0–${IMAGE_COUNT} image URLs. Flux.2 [dev] takes ${FLUX_REF_LIMIT} pixel refs per call; extra images are folded in with follow-up calls (generated image + next leftovers).`,
			],
		});
	}

	if (request.method !== "POST") {
		return json(405, { error: "POST JSON { prompt, images? }" });
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
		const message = err instanceof Error ? err.message : "generation failed";
		console.error("generate failed", message);
		const quota = /4006|neurons|daily free allocation/i.test(message);
		return json(quota ? 429 : 502, { error: message });
	}
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
