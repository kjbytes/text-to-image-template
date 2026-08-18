import { handleRequest } from "../src/index";

const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const pngB64 = btoa(String.fromCharCode(...pngSignature));

const env = {
	AI: {
		run: async (model: string) => {
			if (String(model).includes("flux")) return { image: pngB64 };
			return { response: "warm studio lighting, ceramic mug, wood table" };
		},
	},
} as unknown as Env;

const fetchImpl: typeof fetch = async () =>
	new Response(pngSignature, { headers: { "content-type": "image/png" } });

export default {
	fetch(request: Request): Promise<Response> {
		return handleRequest(request, env, fetchImpl);
	},
};
