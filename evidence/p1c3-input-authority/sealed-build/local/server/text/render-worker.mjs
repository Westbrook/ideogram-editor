import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
//#region src/protocol/json.ts
var JSONError = class extends Error {
	code;
	constructor(code) {
		super(code);
		this.code = code;
	}
};
function scalarOrder(a, b) {
	const aa = Array.from(a, (ch) => ch.codePointAt(0));
	const bb = Array.from(b, (ch) => ch.codePointAt(0));
	for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
	return aa.length - bb.length;
}
function canonical(value) {
	if (value === null) return "null";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new JSONError("MALFORMED_REQUEST");
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		let text = "\"";
		for (const ch of value) {
			const cp = ch.codePointAt(0);
			if (cp >= 55296 && cp <= 57343) throw new JSONError("MALFORMED_REQUEST");
			text += cp < 32 ? `\\u${cp.toString(16).padStart(4, "0")}` : ch === "\"" || ch === "\\" ? `\\${ch}` : ch;
		}
		return text + "\"";
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value !== "object" || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new JSONError("MALFORMED_REQUEST");
	const object = value;
	return `{${Object.keys(object).sort(scalarOrder).map((key) => `${canonical(key)}:${canonical(object[key])}`).join(",")}}`;
}
var profile_default = {
	adapterVersion: "text-worker-1",
	layoutVersion: "layout-1",
	rasterProfile: "ck040-custom3-cpu-rgba8888-unpremul-srgb-transparent-zero-1",
	engine: {
		"package": "canvaskit-wasm",
		"version": "0.40.0-ideogram.3",
		"distribution": "local reproducible CPU Paragraph build from official source; not npm-byte-equivalent",
		"tarball": {
			"bytes": 2088133,
			"sha256": "3528e0ce6183998fc34a6a2a3963b3c2518d0df8ca9d3f8c89fa4b20cd2ef538",
			"gzipBytes": 2087691
		},
		"js": {
			"bytes": 73594,
			"sha256": "867b8ff817783c7554485dcf5b11b6f9de878178a14236b0e81305418fb1189f",
			"gzipBytes": 23969
		},
		"wasm": {
			"bytes": 4979358,
			"sha256": "26389aa33388a205d355b04b48d3c00965db73d6781ae297f6e2f27e8631bb19",
			"gzipBytes": 2021768
		},
		"sourceRevision": "5f262bd2cbb40f78659ec32547163fe83117a38d",
		"sourceAttribution": "Locally built official source archive and exact DEPS; explicit source patch and pinned tools",
		"paperAnchor": "ae33954b4932e71f2bdfbe58ad3d1cde7980db7c",
		"license": "BSD-3-Clause",
		"customBuild": {
			"source": "5f262bd2cbb40f78659ec32547163fe83117a38d",
			"emscripten": "3.1.44",
			"llvm": "a8cbd27d1f238e104a5d5ca345d93bc1f4d4ab1f",
			"recipe": "tooling/text/configure-source.py",
			"patch": "tooling/text/canvaskit-source.patch",
			"initialBytes": 16777216,
			"maximumBytes": 33554432,
			"icuDataSha256": "c12537022ef818991a7bfed41a76d8d6ae962ffbc0e6511ac762a5d0845e7f7c"
		}
	},
	unicode: {
		"policy": "first-strong-per-LF-paragraph-isolate-aware-15.1.0",
		"bidiData": {
			"bytes": 166678,
			"sha256": "b57884c59a3a5348d86faed39965bbddb4e4493d3c16c1ec378ec26bfb5821be",
			"gzipBytes": 41877
		},
		"shaper": "ICU compiled into sealed WASM; default non-client build",
		"sourceUnicodeVersion": "15.1",
		"sourceICURevision": "364118a1d9da24bb5b770ac3d762ac144d6da5a4",
		"unicodeDataHash": "sha256:c12537022ef818991a7bfed41a76d8d6ae962ffbc0e6511ac762a5d0845e7f7c",
		"unicodeDataHashScope": "actual pinned ICU flutter/icudtl.dat compiled into custom WASM"
	},
	fonts: [
		{
			"id": "NotoSans",
			"file": "fonts/NotoSans-Regular.ttf",
			"url": "https://raw.githubusercontent.com/notofonts/noto-fonts/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSans/NotoSans-Regular.ttf",
			"bytes": 569208,
			"sha256": "b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5",
			"gzipBytes": 283990,
			"faceIndex": 0,
			"licenseFile": "notices/Noto-OFL.txt",
			"licenseHash": "sha256:0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb",
			"embedding": "permitted",
			"license": "OFL-1.1",
			"unmodified": true
		},
		{
			"id": "NotoSansArabic",
			"file": "fonts/NotoSansArabic-Regular.ttf",
			"url": "https://raw.githubusercontent.com/notofonts/noto-fonts/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSansArabic/NotoSansArabic-Regular.ttf",
			"bytes": 240456,
			"sha256": "ceea25b464a656dc3b26849bab9356740401af62aedf1bfa8b7f0d9b75925b1b",
			"gzipBytes": 105678,
			"faceIndex": 0,
			"licenseFile": "notices/Noto-OFL.txt",
			"licenseHash": "sha256:0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb",
			"embedding": "permitted",
			"license": "OFL-1.1",
			"unmodified": true
		},
		{
			"id": "NotoSansSymbols2",
			"file": "fonts/NotoSansSymbols2-Regular.ttf",
			"url": "https://raw.githubusercontent.com/notofonts/noto-fonts/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSansSymbols2/NotoSansSymbols2-Regular.ttf",
			"bytes": 656852,
			"sha256": "630846d528dbe4c4981370a4d0a9475a1fd1491a129bb411f8e157cdb5de13c6",
			"gzipBytes": 297016,
			"faceIndex": 0,
			"licenseFile": "notices/Noto-OFL.txt",
			"licenseHash": "sha256:0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb",
			"embedding": "permitted",
			"license": "OFL-1.1",
			"unmodified": true
		},
		{
			"id": "NotoSansCJKsc",
			"file": "fonts/NotoSansCJKsc-Regular.otf",
			"url": "https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
			"bytes": 16437364,
			"sha256": "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b",
			"gzipBytes": 13585906,
			"faceIndex": 0,
			"licenseFile": "notices/Noto-CJK-OFL.txt",
			"licenseHash": "sha256:6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2",
			"embedding": "permitted",
			"license": "OFL-1.1",
			"unmodified": true
		}
	],
	limits: {
		"wasmHeapBytes": 134217728,
		"faceBytes": 16777216,
		"faces": 16,
		"fontBytes": 67108864,
		"textBytes": 16384,
		"logicalLines": 256,
		"pixels": 25e6,
		"layoutBytes": 8388608
	},
	fontProfile: "static regular upright normal-width TTF/CFF1 OTF; complete unmodified files; face index0",
	lineHeightPolicy: "largest supplied font metric span times multiplier; symmetric leading; native rounded baselines",
	memory: {
		"wasmDeclaredInitialBytes": 16777216,
		"wasmDeclaredMaximumBytes": 33554432,
		"aggregateFontShapingCeilingQualified": false,
		"admission": "shared realm preallocation R35 128MiB within R18 512MiB; MEMORY.txt exact model",
		"ownership": "booked reusable worker; <=16 retained exact native faces; bounded latest queue and one cold cache-capacity retry; successful terminate releases private leases once, caller/prepared leases remain; actual API failure retains uncertain capacity",
		"integration": "durable-state-v1: one realm envelope shared with sole writer font/raster admission; exact output consumption and release",
		"limitation": "logical owned-allocation reservations and process admission guards; no RSS/P3 qualification"
	},
	notices: [
		{
			"path": "vendor/text/notices/Brotli-LICENSE",
			"bytes": 1084,
			"sha256": "3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94"
		},
		{
			"path": "vendor/text/notices/CanvasKit-LICENSE",
			"bytes": 1635,
			"sha256": "d27678cba0d529e77201e2d2a053628143e986aad8f1e77f7039ad4366c8f978"
		},
		{
			"path": "vendor/text/notices/Emscripten-LICENSE",
			"bytes": 5093,
			"sha256": "620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86"
		},
		{
			"path": "vendor/text/notices/Expat-COPYING",
			"bytes": 1144,
			"sha256": "122f2c27000472a201d337b9b31f7eb2b52d091b02857061a8880371612d9534"
		},
		{
			"path": "vendor/text/notices/FreeType-FTL.TXT",
			"bytes": 6743,
			"sha256": "08c135755dd589039470f1fdbb400daaabaaa50d0b366d19cebff4d22986baa1"
		},
		{
			"path": "vendor/text/notices/HarfBuzz-COPYING",
			"bytes": 1971,
			"sha256": "ba8f810f2455c2f08e2d56bb49b72f37fcf68f1f4fade38977cfd7372050ad64"
		},
		{
			"path": "vendor/text/notices/Noto-CJK-OFL.txt",
			"bytes": 4301,
			"sha256": "6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2"
		},
		{
			"path": "vendor/text/notices/Noto-OFL.txt",
			"bytes": 4377,
			"sha256": "0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb"
		},
		{
			"path": "vendor/text/notices/Unicode-LICENSE.txt",
			"bytes": 1995,
			"sha256": "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96"
		},
		{
			"path": "vendor/text/notices/Wuffs-LICENSE",
			"bytes": 10174,
			"sha256": "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594"
		},
		{
			"path": "vendor/text/notices/custom-emscripten-LICENSE.txt",
			"bytes": 5093,
			"sha256": "620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86"
		},
		{
			"path": "vendor/text/notices/custom-freetype-LICENSE.txt",
			"bytes": 6743,
			"sha256": "08c135755dd589039470f1fdbb400daaabaaa50d0b366d19cebff4d22986baa1"
		},
		{
			"path": "vendor/text/notices/custom-harfbuzz-LICENSE.txt",
			"bytes": 1971,
			"sha256": "ba8f810f2455c2f08e2d56bb49b72f37fcf68f1f4fade38977cfd7372050ad64"
		},
		{
			"path": "vendor/text/notices/custom-icu-LICENSE.txt",
			"bytes": 25185,
			"sha256": "17510cf7a58b4879b887ec05a45d72cf1b73544dd9ec7e72f20110ed104229ee"
		},
		{
			"path": "vendor/text/notices/custom-libpng-LICENSE.txt",
			"bytes": 5345,
			"sha256": "7317e078e2d3b5d7ba5a6159e650945153262b44b76f6700f8e9edb261c5143e"
		},
		{
			"path": "vendor/text/notices/custom-skia-LICENSE.txt",
			"bytes": 1507,
			"sha256": "5f787c1dee3c56547f09ccc2906ab5f5293c4d8dd6c8654e573216c38e908dbd"
		},
		{
			"path": "vendor/text/notices/custom-wuffs-LICENSE.txt",
			"bytes": 11358,
			"sha256": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
		},
		{
			"path": "vendor/text/notices/custom-zlib-LICENSE.txt",
			"bytes": 910,
			"sha256": "e1cfcc55c325b3f78cf55df9664abaa066e2271dffe8213347d9fccdfbac8f2c"
		},
		{
			"path": "vendor/text/notices/icu-LICENSE",
			"bytes": 25185,
			"sha256": "17510cf7a58b4879b887ec05a45d72cf1b73544dd9ec7e72f20110ed104229ee"
		},
		{
			"path": "vendor/text/notices/libjpeg-turbo-LICENSE",
			"bytes": 5213,
			"sha256": "60c756742db3ad1913304e8b13f0e86e22e51adb50cc0b3333c163f7e45ceec1"
		},
		{
			"path": "vendor/text/notices/libpng-LICENSE",
			"bytes": 5345,
			"sha256": "7317e078e2d3b5d7ba5a6159e650945153262b44b76f6700f8e9edb261c5143e"
		},
		{
			"path": "vendor/text/notices/libwebp-COPYING",
			"bytes": 1496,
			"sha256": "5aec868f669e384a22372a4e8a1a6cd7d44c64cd451f960ca69cc170d1e13acf"
		},
		{
			"path": "vendor/text/notices/zlib-LICENSE",
			"bytes": 1002,
			"sha256": "845efc77857d485d91fb3e0b884aaa929368c717ae8186b66fe1ed2495753243"
		}
	],
	adapterSources: [
		{
			"path": "src/text/admission.ts",
			"bytes": 4357,
			"sha256": "be0ae31c17e9d0497a27a49d0b15f1be7672c20c5752e8423ad71f0f06fc5e1a"
		},
		{
			"path": "src/text/bidi-data.json",
			"bytes": 19070,
			"sha256": "df36e677252814e1d84009c9ab735c12ac67deb7460695d64b477beee00b955a"
		},
		{
			"path": "src/text/bidi.ts",
			"bytes": 632,
			"sha256": "9fbc954b46188247d44c829ce82bba259de40dbcbb0100380c43aa8e7b961350"
		},
		{
			"path": "src/text/bundled-fonts.ts",
			"bytes": 1857,
			"sha256": "14772cc968adf2512319ee2be18062db6b8ab32a591e1c0bdc3efe0305494c84"
		},
		{
			"path": "src/text/client.ts",
			"bytes": 8280,
			"sha256": "816e12e15406e993f8271dfa3ae397eba2d1b552470c21c0def339e0fcca53e6"
		},
		{
			"path": "src/text/contracts.ts",
			"bytes": 3508,
			"sha256": "80173a85fd2eeca2cac63ea0806c23643668dfc2c3249859e9d07426e3730686"
		},
		{
			"path": "src/text/core.ts",
			"bytes": 16793,
			"sha256": "69cb9bb9d2e97be39ef5faaa76b2f05b98c3ba40d2b3b0c18624b1f08a2bf1ed"
		},
		{
			"path": "src/text/durable.ts",
			"bytes": 6365,
			"sha256": "a5bce2aa7dad1678b3af6df93f8cdbc7c841dddca507eb176673011b699cd3e5"
		},
		{
			"path": "src/text/engine.ts",
			"bytes": 1476,
			"sha256": "c86d782ccb92de17fb4a01376e16989b13114156abcd6418a011af43efb5c830"
		},
		{
			"path": "src/text/font.ts",
			"bytes": 4272,
			"sha256": "76a715d1e84212ae66dcbe34c55ae8a879e473bfea299987018a7d7bd9380b01"
		},
		{
			"path": "src/text/memory.ts",
			"bytes": 3818,
			"sha256": "c219b844ba9621234422df6df1e49f73e6d8b226a5241a4f7405d066e03b27ee"
		},
		{
			"path": "src/text/worker.ts",
			"bytes": 1071,
			"sha256": "ab8f349c39579dc41c277438f9f3de60255d6f447e2d0c42ad4c30ed4da5ad1e"
		}
	],
	typeCompatibility: {
		"path": "vendor/text/canvaskit.d.ts",
		"sha256": "b77844bc1c2c9b12960bcecb5299c6b4e5dc5a07aa2ccf026124287a1b3f50f4",
		"change": "Only upstream triple-slash WebGPU reference replaced by comment; TypeScript7 lib.dom already supplies WebGPU declarations. Common upstream declarations unchanged; custom APIs are explicitly typed in the adapter."
	},
	sourceRecipe: [
		{
			"path": "tooling/text/source-closure.json",
			"bytes": 7326,
			"sha256": "c7cb9b9febbf9464800aaa46d4044243629400e8e3d836771f99c2d01dc4c993"
		},
		{
			"path": "tooling/text/configure-source.py",
			"bytes": 3535,
			"sha256": "b1f04570cd6a854312b58017e95f75a59155ffdb1ed6e71792ca5b2653dd768c"
		},
		{
			"path": "tooling/text/canvaskit-source.patch",
			"bytes": 3975,
			"sha256": "aef6f9481e8bf71bb942b24dd58dc5dd6849dec6122d571094e0ab658509c5a6"
		},
		{
			"path": "tooling/text/rebuild.py",
			"bytes": 3463,
			"sha256": "18f8afb2cc9341aedc30f2712fa21727250543dd91f7c966bd105171d689b33d"
		},
		{
			"path": "tooling/text/MEMORY.txt",
			"bytes": 6499,
			"sha256": "882bc204eadd21c2b1c58ac7946be2f168c7997df064a5f475f664b74e52f8c1"
		},
		{
			"path": "server/static.ts",
			"bytes": 4589,
			"sha256": "17113de5a2cad06f94e1788a7a25bf71656d77d5f48f5371910a8a6159cf5cac"
		},
		{
			"path": "server/http.ts",
			"bytes": 14400,
			"sha256": "ae99c41cb2f198f5d1f7852bb1a4e84fda5a2e05f422e4c8b0462d400818c429"
		},
		{
			"path": "server/storage/text.ts",
			"bytes": 13296,
			"sha256": "1486a8ae7349daa55a00a9a4c5979b1b4d062f73c4a0b01c4e00da4f473082d2"
		},
		{
			"path": "server/text/font.ts",
			"bytes": 4425,
			"sha256": "0093e9341c3b39e93065fa4ab4736fb0ae46f39314b5fb4af227d5e22d239ade"
		},
		{
			"path": "server/text/worker.ts",
			"bytes": 561,
			"sha256": "bff44a473836e51538e93a1c56363f009a17c48fa18bbe487596576d41d8848f"
		},
		{
			"path": "server/text/supervisor.ts",
			"bytes": 1504,
			"sha256": "ad066c86979d8e4eb6ae66ba3b53c5b629d7b1f01422bc36fee377e266c96bc1"
		},
		{
			"path": "server/text/validation.ts",
			"bytes": 9495,
			"sha256": "7349c725e0190a2c775a1240a2dd4a17f6abb084e0a31659814f383eade261e4"
		},
		{
			"path": "server/text/render-worker.mjs",
			"bytes": 2720,
			"sha256": "90e01ed67bac35e425ee5ca75187fe80d7476ea6cf18b28f7897aae0d4a24ff9"
		},
		{
			"path": "tests/text-state/verifier.vite.config.ts",
			"bytes": 330,
			"sha256": "e1f41d22e2b89b621c9ac1960bc932ef8fd3a646fb350446f2aba614b6ef38a7"
		},
		{
			"path": "tooling/text/verifier.vite.config.ts",
			"bytes": 318,
			"sha256": "01a84de54aac11eddbe4bb9ba1aa2c986060e67774f861e65f03a7bce4aa387c"
		},
		{
			"path": "src/protocol/text-budget.ts",
			"bytes": 1118,
			"sha256": "273f6a5be4b183df0249fed558b05dcd33e58d53b0ed20bafcb02ae110df80e0"
		},
		{
			"path": "src/text/retained-profiles/b89503d3.json",
			"bytes": 14238,
			"sha256": "39b0190db275a08547f01494eb3f2725cdb7d2d3cb7a8e92abe42bbae6c5dee8"
		},
		{
			"path": "src/protocol/text.ts",
			"bytes": 7722,
			"sha256": "f54a1057aae3e28d6def4536ad4c62d4246bb858682694d5b9723d703cb219cb"
		},
		{
			"path": "src/text/retained-profiles/c19791ae.json",
			"bytes": 12986,
			"sha256": "80d5dfb1f0f89548969c97348b57d0ddc6e8098f719de97dfb9feb9839734d2b"
		},
		{
			"path": "src/text/retained-profiles/6e8a481e.json",
			"bytes": 15396,
			"sha256": "15634d19418bc21841fa8093de2ae7598b752c2f158be90f6e7e06216d79d6da"
		},
		{
			"path": "src/text/retained-profiles/d047f5be.json",
			"bytes": 15572,
			"sha256": "d2cd5204fa8822a0ae17f610ada9add6b083ab90097d16b14397193522f54b1e"
		}
	],
	id: "sha256:304528c98255447a3c8b4607b3b6738261dad46c485c84c203e9c16ae1f69a29"
};
//#endregion
//#region src/text/contracts.ts
var LIMITS = Object.freeze({
	textBytes: 16384,
	lines: 256,
	faces: 16,
	faceBytes: 16 * 1024 ** 2,
	fontBytes: 64 * 1024 ** 2,
	wasmBytes: 32 * 1024 ** 2,
	pixels: 25e6,
	side: 8192,
	layoutBytes: 8 * 1024 ** 2,
	deadlineMs: 2e4
});
var TextFailure = class extends Error {
	code;
	details;
	constructor(code, details = null) {
		super(code);
		this.code = code;
		this.details = details;
		this.name = "TextFailure";
	}
};
function fail(code, details) {
	throw new TextFailure(code, details);
}
async function hashBytes(bytes) {
	const data = bytes instanceof Blob ? await bytes.arrayBuffer() : bytes;
	return "sha256:" + Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) => b.toString(16).padStart(2, "0")).join("");
}
//#endregion
//#region src/text/admission.ts
function textIndices(text) {
	scanText(text);
	const utf16ToUtf8 = Array(text.length + 1).fill(-1), utf8ToUtf16 = [];
	const scalars = [];
	let bytes = 0, lines = 1;
	for (let i = 0; i < text.length;) {
		const cp = text.codePointAt(i);
		if (cp >= 55296 && cp <= 57343) fail("TEXT_SURROGATE", { utf16: i });
		if (cp === 13) fail("TEXT_REQUIRES_REVIEWED_LF_CONVERSION");
		if (cp === 10) lines++;
		const count = cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
		utf16ToUtf8[i] = bytes;
		utf8ToUtf16[bytes] = i;
		scalars.push({
			codepoint: cp,
			utf16: i,
			utf8: bytes
		});
		for (let j = 1; j < count; j++) utf8ToUtf16[bytes + j] = -1;
		bytes += count;
		i += cp > 65535 ? 2 : 1;
	}
	if (bytes > LIMITS.textBytes) fail("TEXT_BYTES");
	if (lines > LIMITS.lines) fail("TEXT_LINES");
	utf16ToUtf8[text.length] = bytes;
	utf8ToUtf16[bytes] = text.length;
	return {
		utf16ToUtf8,
		utf8ToUtf16,
		scalars,
		bytes,
		lines
	};
}
function scanText(text) {
	if (typeof text !== "string" || text.length > LIMITS.textBytes) fail("TEXT_BYTES");
	let bytes = 0, lines = 1, scalars = 0;
	for (let i = 0; i < text.length;) {
		const cp = text.codePointAt(i);
		if (cp >= 55296 && cp <= 57343) fail("TEXT_SURROGATE", { utf16: i });
		if (cp === 13) fail("TEXT_REQUIRES_REVIEWED_LF_CONVERSION");
		if (cp === 10) lines++;
		bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
		scalars++;
		i += cp > 65535 ? 2 : 1;
	}
	if (bytes > LIMITS.textBytes) fail("TEXT_BYTES");
	if (lines > LIMITS.lines) fail("TEXT_LINES");
	return {
		bytes,
		lines,
		scalars
	};
}
function admitRequest(request) {
	if (!request || !request.token || !request.style || !request.frame || !Array.isArray(request.fonts)) fail("TEXT_REQUEST");
	const { token, style, frame, fonts } = request;
	for (const key of [
		"documentId",
		"documentRevision",
		"layerId",
		"layerVersion",
		"sessionId"
	]) if (typeof token[key] !== "string" || !token[key].length || token[key].length > 256) fail("TEXT_TOKEN");
	if (!Number.isSafeInteger(token.generation) || token.generation < 0) fail("TEXT_TOKEN");
	const indices = scanText(request.text);
	if (![frame.width, frame.height].every((n) => Number.isFinite(n) && n > 0 && n <= LIMITS.side) || Math.ceil(frame.width) * Math.ceil(frame.height) > LIMITS.pixels) fail("TEXT_FRAME");
	if (![style.sizePx, style.lineHeightMultiplier].every((n) => Number.isFinite(n) && n > 0) || style.sizePx > LIMITS.side || style.lineHeightMultiplier * style.sizePx > LIMITS.side) fail("TEXT_STYLE_LIMIT");
	if (![
		"left",
		"center",
		"right",
		"start",
		"end"
	].includes(style.align) || ![
		"auto",
		"ltr",
		"rtl"
	].includes(style.direction) || !Array.isArray(style.fill) || style.fill.length !== 4 || !style.fill.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) fail("TEXT_STYLE");
	if (!Array.isArray(style.explicitFallbacks) || style.explicitFallbacks.length >= LIMITS.faces || fonts.length < 1 || fonts.length > LIMITS.faces) fail("FONT_ORDER");
	const order = [style.primaryFont, ...style.explicitFallbacks];
	if (fonts.length < 1 || fonts.length > LIMITS.faces || order.length !== fonts.length || new Set(order).size !== order.length) fail("FONT_ORDER");
	let total = 0;
	const hashes = /* @__PURE__ */ new Set();
	for (const font of fonts) {
		if (!font || !/^sha256:[a-f0-9]{64}$/.test(font.hash) || hashes.has(font.hash) || !order.includes(font.hash)) fail("FONT_ORDER");
		if (!(font.bytes instanceof Blob) || font.bytes.size > LIMITS.faceBytes) fail("FONT_SIZE");
		if (font.faceIndex !== 0) fail("FONT_FACE_INDEX");
		if (!["bundled", "local-file"].includes(font.origin) || font.license?.embedding !== "permitted" || !/^sha256:[a-f0-9]{64}$/.test(font.license.hash)) fail("FONT_EMBEDDING_UNKNOWN");
		total += font.bytes.size;
		hashes.add(font.hash);
	}
	if (total > LIMITS.fontBytes) fail("FONT_SET_SIZE");
	return {
		indices,
		order,
		total
	};
}
//#endregion
//#region src/text/font.ts
var PARSER_PROFILE = "sfnt-static-1-freetype-canvaskit040";
function inspectFont(bytes) {
	if (bytes.byteLength < 12 || bytes.byteLength > LIMITS.faceBytes) fail("FONT_SIZE");
	const view = new DataView(bytes), data = new Uint8Array(bytes);
	const u16 = (at) => view.getUint16(at), u32 = (at) => view.getUint32(at);
	const signature = u32(0), count = u16(4), end = 12 + count * 16;
	if (signature !== 65536 && signature !== 1330926671) fail("FONT_STATIC_SFNT_REQUIRED");
	if (!count || count > 128 || end > bytes.byteLength) fail("FONT_TABLE_DIRECTORY");
	const tables = /* @__PURE__ */ new Map();
	const ranges = [];
	for (let i = 0; i < count; i++) {
		const at = 12 + i * 16, tag = String.fromCharCode(...data.subarray(at, at + 4));
		const checksum = u32(at + 4), offset = u32(at + 8), length = u32(at + 12);
		if (tables.has(tag) || !/^[\x20-\x7e]{4}$/.test(tag) || offset % 4 || offset < end || offset + length > bytes.byteLength || !length) fail("FONT_TABLE_BOUNDS", { tag });
		if (ranges.some(([start, stop]) => offset < stop && start < offset + length)) fail("FONT_TABLE_OVERLAP");
		let sum = 0;
		for (let j = 0; j < length; j += 4) {
			let value = 0;
			for (let k = 0; k < 4; k++) value = value * 256 + (j + k < length && !(tag === "head" && j + k >= 8 && j + k < 12) ? data[offset + j + k] : 0);
			sum = sum + value >>> 0;
		}
		if (sum !== checksum) fail("FONT_TABLE_CHECKSUM", { tag });
		tables.set(tag, {
			offset,
			length
		});
		ranges.push([offset, offset + length]);
	}
	for (const tag of [
		"fvar",
		"gvar",
		"CFF2",
		"SVG ",
		"COLR",
		"CPAL",
		"CBDT",
		"CBLC",
		"sbix"
	]) if (tables.has(tag)) fail("FONT_UNSUPPORTED_TABLE", { tag });
	function required(tag, size) {
		const entry = tables.get(tag);
		if (!entry || entry.length < size) fail("FONT_REQUIRED_TABLE", { tag });
		return entry;
	}
	const head = required("head", 54), os2 = required("OS/2", 78), maxp = required("maxp", 6);
	required("name", 6);
	required("cmap", 4);
	required("hhea", 36);
	required("hmtx", 4);
	if (u32(head.offset + 12) !== 1594834165 || u16(head.offset + 18) < 16 || u16(head.offset + 18) > 16384 || !u16(maxp.offset + 4)) fail("FONT_METRICS");
	const fsType = u16(os2.offset + 8);
	if (fsType & -265 || (fsType & 14) !== 0 && (fsType & 14) !== 8) fail("FONT_EMBEDDING_RESTRICTED", { fsType });
	if (u16(os2.offset) > 5) fail("FONT_OS2_VERSION");
	if (u16(os2.offset + 4) !== 400 || u16(os2.offset + 6) !== 5 || u16(os2.offset + 62) & 513) fail("FONT_STYLE_UNSUPPORTED");
	if (signature === 65536) {
		const glyf = required("glyf", 1), loca = required("loca", 2), glyphCount = u16(maxp.offset + 4), format = view.getInt16(head.offset + 50);
		if (format !== 0 && format !== 1) fail("FONT_LOCA");
		const stride = format === 0 ? 2 : 4;
		if (loca.length < (glyphCount + 1) * stride) fail("FONT_LOCA");
		let previous = 0;
		for (let i = 0; i <= glyphCount; i++) {
			const next = stride === 2 ? u16(loca.offset + i * 2) * 2 : u32(loca.offset + i * 4);
			if (next < previous || next > glyf.length || next !== previous && next - previous < 10) fail("FONT_LOCA");
			previous = next;
		}
	} else {
		const cff = required("CFF ", 4);
		if (data[cff.offset] !== 1 || data[cff.offset + 2] < 4 || data[cff.offset + 2] >= cff.length || data[cff.offset + 3] < 1 || data[cff.offset + 3] > 4) fail("FONT_CFF_HEADER");
	}
	return {
		format: signature === 65536 ? "static-ttf" : "static-otf",
		parserProfile: PARSER_PROFILE,
		fsType,
		glyphCount: u16(maxp.offset + 4),
		tableCount: count
	};
}
//#endregion
//#region src/text/bidi-data.json
var bidi_data_default = /*#__PURE__*/ JSON.parse("[[65,90,0],[97,122,0],[170,170,0],[181,181,0],[186,186,0],[192,214,0],[216,246,0],[248,442,0],[443,443,0],[444,447,0],[448,451,0],[452,659,0],[660,660,0],[661,687,0],[688,696,0],[699,705,0],[720,721,0],[736,740,0],[750,750,0],[880,883,0],[886,887,0],[890,890,0],[891,893,0],[895,895,0],[902,902,0],[904,906,0],[908,908,0],[910,929,0],[931,1013,0],[1015,1153,0],[1154,1154,0],[1162,1327,0],[1329,1366,0],[1369,1369,0],[1370,1375,0],[1376,1416,0],[1417,1417,0],[1470,1470,1],[1472,1472,1],[1475,1475,1],[1478,1478,1],[1488,1514,1],[1519,1522,1],[1523,1524,1],[1544,1544,1],[1547,1547,1],[1549,1549,1],[1563,1563,1],[1564,1564,1],[1565,1567,1],[1568,1599,1],[1600,1600,1],[1601,1610,1],[1645,1645,1],[1646,1647,1],[1649,1747,1],[1748,1748,1],[1749,1749,1],[1765,1766,1],[1774,1775,1],[1786,1788,1],[1789,1790,1],[1791,1791,1],[1792,1805,1],[1807,1807,1],[1808,1808,1],[1810,1839,1],[1869,1957,1],[1969,1969,1],[1984,1993,1],[1994,2026,1],[2036,2037,1],[2042,2042,1],[2046,2047,1],[2048,2069,1],[2074,2074,1],[2084,2084,1],[2088,2088,1],[2096,2110,1],[2112,2136,1],[2142,2142,1],[2144,2154,1],[2160,2183,1],[2184,2184,1],[2185,2190,1],[2208,2248,1],[2249,2249,1],[2307,2307,0],[2308,2361,0],[2363,2363,0],[2365,2365,0],[2366,2368,0],[2377,2380,0],[2382,2383,0],[2384,2384,0],[2392,2401,0],[2404,2405,0],[2406,2415,0],[2416,2416,0],[2417,2417,0],[2418,2432,0],[2434,2435,0],[2437,2444,0],[2447,2448,0],[2451,2472,0],[2474,2480,0],[2482,2482,0],[2486,2489,0],[2493,2493,0],[2494,2496,0],[2503,2504,0],[2507,2508,0],[2510,2510,0],[2519,2519,0],[2524,2525,0],[2527,2529,0],[2534,2543,0],[2544,2545,0],[2548,2553,0],[2554,2554,0],[2556,2556,0],[2557,2557,0],[2563,2563,0],[2565,2570,0],[2575,2576,0],[2579,2600,0],[2602,2608,0],[2610,2611,0],[2613,2614,0],[2616,2617,0],[2622,2624,0],[2649,2652,0],[2654,2654,0],[2662,2671,0],[2674,2676,0],[2678,2678,0],[2691,2691,0],[2693,2701,0],[2703,2705,0],[2707,2728,0],[2730,2736,0],[2738,2739,0],[2741,2745,0],[2749,2749,0],[2750,2752,0],[2761,2761,0],[2763,2764,0],[2768,2768,0],[2784,2785,0],[2790,2799,0],[2800,2800,0],[2809,2809,0],[2818,2819,0],[2821,2828,0],[2831,2832,0],[2835,2856,0],[2858,2864,0],[2866,2867,0],[2869,2873,0],[2877,2877,0],[2878,2878,0],[2880,2880,0],[2887,2888,0],[2891,2892,0],[2903,2903,0],[2908,2909,0],[2911,2913,0],[2918,2927,0],[2928,2928,0],[2929,2929,0],[2930,2935,0],[2947,2947,0],[2949,2954,0],[2958,2960,0],[2962,2965,0],[2969,2970,0],[2972,2972,0],[2974,2975,0],[2979,2980,0],[2984,2986,0],[2990,3001,0],[3006,3007,0],[3009,3010,0],[3014,3016,0],[3018,3020,0],[3024,3024,0],[3031,3031,0],[3046,3055,0],[3056,3058,0],[3073,3075,0],[3077,3084,0],[3086,3088,0],[3090,3112,0],[3114,3129,0],[3133,3133,0],[3137,3140,0],[3160,3162,0],[3165,3165,0],[3168,3169,0],[3174,3183,0],[3191,3191,0],[3199,3199,0],[3200,3200,0],[3202,3203,0],[3204,3204,0],[3205,3212,0],[3214,3216,0],[3218,3240,0],[3242,3251,0],[3253,3257,0],[3261,3261,0],[3262,3262,0],[3263,3263,0],[3264,3268,0],[3270,3270,0],[3271,3272,0],[3274,3275,0],[3285,3286,0],[3293,3294,0],[3296,3297,0],[3302,3311,0],[3313,3314,0],[3315,3315,0],[3330,3331,0],[3332,3340,0],[3342,3344,0],[3346,3386,0],[3389,3389,0],[3390,3392,0],[3398,3400,0],[3402,3404,0],[3406,3406,0],[3407,3407,0],[3412,3414,0],[3415,3415,0],[3416,3422,0],[3423,3425,0],[3430,3439,0],[3440,3448,0],[3449,3449,0],[3450,3455,0],[3458,3459,0],[3461,3478,0],[3482,3505,0],[3507,3515,0],[3517,3517,0],[3520,3526,0],[3535,3537,0],[3544,3551,0],[3558,3567,0],[3570,3571,0],[3572,3572,0],[3585,3632,0],[3634,3635,0],[3648,3653,0],[3654,3654,0],[3663,3663,0],[3664,3673,0],[3674,3675,0],[3713,3714,0],[3716,3716,0],[3718,3722,0],[3724,3747,0],[3749,3749,0],[3751,3760,0],[3762,3763,0],[3773,3773,0],[3776,3780,0],[3782,3782,0],[3792,3801,0],[3804,3807,0],[3840,3840,0],[3841,3843,0],[3844,3858,0],[3859,3859,0],[3860,3860,0],[3861,3863,0],[3866,3871,0],[3872,3881,0],[3882,3891,0],[3892,3892,0],[3894,3894,0],[3896,3896,0],[3902,3903,0],[3904,3911,0],[3913,3948,0],[3967,3967,0],[3973,3973,0],[3976,3980,0],[4030,4037,0],[4039,4044,0],[4046,4047,0],[4048,4052,0],[4053,4056,0],[4057,4058,0],[4096,4138,0],[4139,4140,0],[4145,4145,0],[4152,4152,0],[4155,4156,0],[4159,4159,0],[4160,4169,0],[4170,4175,0],[4176,4181,0],[4182,4183,0],[4186,4189,0],[4193,4193,0],[4194,4196,0],[4197,4198,0],[4199,4205,0],[4206,4208,0],[4213,4225,0],[4227,4228,0],[4231,4236,0],[4238,4238,0],[4239,4239,0],[4240,4249,0],[4250,4252,0],[4254,4255,0],[4256,4293,0],[4295,4295,0],[4301,4301,0],[4304,4346,0],[4347,4347,0],[4348,4348,0],[4349,4351,0],[4352,4680,0],[4682,4685,0],[4688,4694,0],[4696,4696,0],[4698,4701,0],[4704,4744,0],[4746,4749,0],[4752,4784,0],[4786,4789,0],[4792,4798,0],[4800,4800,0],[4802,4805,0],[4808,4822,0],[4824,4880,0],[4882,4885,0],[4888,4954,0],[4960,4968,0],[4969,4988,0],[4992,5007,0],[5024,5109,0],[5112,5117,0],[5121,5740,0],[5741,5741,0],[5742,5742,0],[5743,5759,0],[5761,5786,0],[5792,5866,0],[5867,5869,0],[5870,5872,0],[5873,5880,0],[5888,5905,0],[5909,5909,0],[5919,5937,0],[5940,5940,0],[5941,5942,0],[5952,5969,0],[5984,5996,0],[5998,6000,0],[6016,6067,0],[6070,6070,0],[6078,6085,0],[6087,6088,0],[6100,6102,0],[6103,6103,0],[6104,6106,0],[6108,6108,0],[6112,6121,0],[6160,6169,0],[6176,6210,0],[6211,6211,0],[6212,6264,0],[6272,6276,0],[6279,6312,0],[6314,6314,0],[6320,6389,0],[6400,6430,0],[6435,6438,0],[6441,6443,0],[6448,6449,0],[6451,6456,0],[6470,6479,0],[6480,6509,0],[6512,6516,0],[6528,6571,0],[6576,6601,0],[6608,6617,0],[6618,6618,0],[6656,6678,0],[6681,6682,0],[6686,6687,0],[6688,6740,0],[6741,6741,0],[6743,6743,0],[6753,6753,0],[6755,6756,0],[6765,6770,0],[6784,6793,0],[6800,6809,0],[6816,6822,0],[6823,6823,0],[6824,6829,0],[6916,6916,0],[6917,6963,0],[6965,6965,0],[6971,6971,0],[6973,6977,0],[6979,6980,0],[6981,6988,0],[6992,7001,0],[7002,7008,0],[7009,7018,0],[7028,7036,0],[7037,7038,0],[7042,7042,0],[7043,7072,0],[7073,7073,0],[7078,7079,0],[7082,7082,0],[7086,7087,0],[7088,7097,0],[7098,7141,0],[7143,7143,0],[7146,7148,0],[7150,7150,0],[7154,7155,0],[7164,7167,0],[7168,7203,0],[7204,7211,0],[7220,7221,0],[7227,7231,0],[7232,7241,0],[7245,7247,0],[7248,7257,0],[7258,7287,0],[7288,7293,0],[7294,7295,0],[7296,7304,0],[7312,7354,0],[7357,7359,0],[7360,7367,0],[7379,7379,0],[7393,7393,0],[7401,7404,0],[7406,7411,0],[7413,7414,0],[7415,7415,0],[7418,7418,0],[7424,7467,0],[7468,7530,0],[7531,7543,0],[7544,7544,0],[7545,7578,0],[7579,7615,0],[7680,7957,0],[7960,7965,0],[7968,8005,0],[8008,8013,0],[8016,8023,0],[8025,8025,0],[8027,8027,0],[8029,8029,0],[8031,8061,0],[8064,8116,0],[8118,8124,0],[8126,8126,0],[8130,8132,0],[8134,8140,0],[8144,8147,0],[8150,8155,0],[8160,8172,0],[8178,8180,0],[8182,8188,0],[8206,8206,0],[8207,8207,1],[8305,8305,0],[8319,8319,0],[8336,8348,0],[8450,8450,0],[8455,8455,0],[8458,8467,0],[8469,8469,0],[8473,8477,0],[8484,8484,0],[8486,8486,0],[8488,8488,0],[8490,8493,0],[8495,8500,0],[8501,8504,0],[8505,8505,0],[8508,8511,0],[8517,8521,0],[8526,8526,0],[8527,8527,0],[8544,8578,0],[8579,8580,0],[8581,8584,0],[9014,9082,0],[9109,9109,0],[9372,9449,0],[9900,9900,0],[10240,10495,0],[11264,11387,0],[11388,11389,0],[11390,11492,0],[11499,11502,0],[11506,11507,0],[11520,11557,0],[11559,11559,0],[11565,11565,0],[11568,11623,0],[11631,11631,0],[11632,11632,0],[11648,11670,0],[11680,11686,0],[11688,11694,0],[11696,11702,0],[11704,11710,0],[11712,11718,0],[11720,11726,0],[11728,11734,0],[11736,11742,0],[12293,12293,0],[12294,12294,0],[12295,12295,0],[12321,12329,0],[12334,12335,0],[12337,12341,0],[12344,12346,0],[12347,12347,0],[12348,12348,0],[12353,12438,0],[12445,12446,0],[12447,12447,0],[12449,12538,0],[12540,12542,0],[12543,12543,0],[12549,12591,0],[12593,12686,0],[12688,12689,0],[12690,12693,0],[12694,12703,0],[12704,12735,0],[12784,12799,0],[12800,12828,0],[12832,12841,0],[12842,12871,0],[12872,12879,0],[12896,12923,0],[12927,12927,0],[12928,12937,0],[12938,12976,0],[12992,13003,0],[13008,13174,0],[13179,13277,0],[13280,13310,0],[13312,19903,0],[19968,40980,0],[40981,40981,0],[40982,42124,0],[42192,42231,0],[42232,42237,0],[42238,42239,0],[42240,42507,0],[42508,42508,0],[42512,42527,0],[42528,42537,0],[42538,42539,0],[42560,42605,0],[42606,42606,0],[42624,42651,0],[42652,42653,0],[42656,42725,0],[42726,42735,0],[42738,42743,0],[42786,42863,0],[42864,42864,0],[42865,42887,0],[42889,42890,0],[42891,42894,0],[42895,42895,0],[42896,42954,0],[42960,42961,0],[42963,42963,0],[42965,42969,0],[42994,42996,0],[42997,42998,0],[42999,42999,0],[43000,43001,0],[43002,43002,0],[43003,43009,0],[43011,43013,0],[43015,43018,0],[43020,43042,0],[43043,43044,0],[43047,43047,0],[43056,43061,0],[43062,43063,0],[43072,43123,0],[43136,43137,0],[43138,43187,0],[43188,43203,0],[43214,43215,0],[43216,43225,0],[43250,43255,0],[43256,43258,0],[43259,43259,0],[43260,43260,0],[43261,43262,0],[43264,43273,0],[43274,43301,0],[43310,43311,0],[43312,43334,0],[43346,43347,0],[43359,43359,0],[43360,43388,0],[43395,43395,0],[43396,43442,0],[43444,43445,0],[43450,43451,0],[43454,43456,0],[43457,43469,0],[43471,43471,0],[43472,43481,0],[43486,43487,0],[43488,43492,0],[43494,43494,0],[43495,43503,0],[43504,43513,0],[43514,43518,0],[43520,43560,0],[43567,43568,0],[43571,43572,0],[43584,43586,0],[43588,43595,0],[43597,43597,0],[43600,43609,0],[43612,43615,0],[43616,43631,0],[43632,43632,0],[43633,43638,0],[43639,43641,0],[43642,43642,0],[43643,43643,0],[43645,43645,0],[43646,43695,0],[43697,43697,0],[43701,43702,0],[43705,43709,0],[43712,43712,0],[43714,43714,0],[43739,43740,0],[43741,43741,0],[43742,43743,0],[43744,43754,0],[43755,43755,0],[43758,43759,0],[43760,43761,0],[43762,43762,0],[43763,43764,0],[43765,43765,0],[43777,43782,0],[43785,43790,0],[43793,43798,0],[43808,43814,0],[43816,43822,0],[43824,43866,0],[43867,43867,0],[43868,43871,0],[43872,43880,0],[43881,43881,0],[43888,43967,0],[43968,44002,0],[44003,44004,0],[44006,44007,0],[44009,44010,0],[44011,44011,0],[44012,44012,0],[44016,44025,0],[44032,55203,0],[55216,55238,0],[55243,55291,0],[57344,63743,0],[63744,64109,0],[64112,64217,0],[64256,64262,0],[64275,64279,0],[64285,64285,1],[64287,64296,1],[64298,64310,1],[64312,64316,1],[64318,64318,1],[64320,64321,1],[64323,64324,1],[64326,64335,1],[64336,64433,1],[64434,64450,1],[64467,64829,1],[64848,64911,1],[64914,64967,1],[65008,65019,1],[65020,65020,1],[65136,65140,1],[65142,65276,1],[65313,65338,0],[65345,65370,0],[65382,65391,0],[65392,65392,0],[65393,65437,0],[65438,65439,0],[65440,65470,0],[65474,65479,0],[65482,65487,0],[65490,65495,0],[65498,65500,0],[65536,65547,0],[65549,65574,0],[65576,65594,0],[65596,65597,0],[65599,65613,0],[65616,65629,0],[65664,65786,0],[65792,65792,0],[65794,65794,0],[65799,65843,0],[65847,65855,0],[65933,65934,0],[66000,66044,0],[66176,66204,0],[66208,66256,0],[66304,66335,0],[66336,66339,0],[66349,66368,0],[66369,66369,0],[66370,66377,0],[66378,66378,0],[66384,66421,0],[66432,66461,0],[66463,66463,0],[66464,66499,0],[66504,66511,0],[66512,66512,0],[66513,66517,0],[66560,66639,0],[66640,66717,0],[66720,66729,0],[66736,66771,0],[66776,66811,0],[66816,66855,0],[66864,66915,0],[66927,66927,0],[66928,66938,0],[66940,66954,0],[66956,66962,0],[66964,66965,0],[66967,66977,0],[66979,66993,0],[66995,67001,0],[67003,67004,0],[67072,67382,0],[67392,67413,0],[67424,67431,0],[67456,67461,0],[67463,67504,0],[67506,67514,0],[67584,67589,1],[67592,67592,1],[67594,67637,1],[67639,67640,1],[67644,67644,1],[67647,67669,1],[67671,67671,1],[67672,67679,1],[67680,67702,1],[67703,67704,1],[67705,67711,1],[67712,67742,1],[67751,67759,1],[67808,67826,1],[67828,67829,1],[67835,67839,1],[67840,67861,1],[67862,67867,1],[67872,67897,1],[67903,67903,1],[67968,68023,1],[68028,68029,1],[68030,68031,1],[68032,68047,1],[68050,68095,1],[68096,68096,1],[68112,68115,1],[68117,68119,1],[68121,68149,1],[68160,68168,1],[68176,68184,1],[68192,68220,1],[68221,68222,1],[68223,68223,1],[68224,68252,1],[68253,68255,1],[68288,68295,1],[68296,68296,1],[68297,68324,1],[68331,68335,1],[68336,68342,1],[68352,68405,1],[68416,68437,1],[68440,68447,1],[68448,68466,1],[68472,68479,1],[68480,68497,1],[68505,68508,1],[68521,68527,1],[68608,68680,1],[68736,68786,1],[68800,68850,1],[68858,68863,1],[68864,68899,1],[69248,69289,1],[69293,69293,1],[69296,69297,1],[69376,69404,1],[69405,69414,1],[69415,69415,1],[69424,69445,1],[69457,69460,1],[69461,69465,1],[69488,69505,1],[69510,69513,1],[69552,69572,1],[69573,69579,1],[69600,69622,1],[69632,69632,0],[69634,69634,0],[69635,69687,0],[69703,69709,0],[69734,69743,0],[69745,69746,0],[69749,69749,0],[69762,69762,0],[69763,69807,0],[69808,69810,0],[69815,69816,0],[69819,69820,0],[69821,69821,0],[69822,69825,0],[69837,69837,0],[69840,69864,0],[69872,69881,0],[69891,69926,0],[69932,69932,0],[69942,69951,0],[69952,69955,0],[69956,69956,0],[69957,69958,0],[69959,69959,0],[69968,70002,0],[70004,70005,0],[70006,70006,0],[70018,70018,0],[70019,70066,0],[70067,70069,0],[70079,70080,0],[70081,70084,0],[70085,70088,0],[70093,70093,0],[70094,70094,0],[70096,70105,0],[70106,70106,0],[70107,70107,0],[70108,70108,0],[70109,70111,0],[70113,70132,0],[70144,70161,0],[70163,70187,0],[70188,70190,0],[70194,70195,0],[70197,70197,0],[70200,70205,0],[70207,70208,0],[70272,70278,0],[70280,70280,0],[70282,70285,0],[70287,70301,0],[70303,70312,0],[70313,70313,0],[70320,70366,0],[70368,70370,0],[70384,70393,0],[70402,70403,0],[70405,70412,0],[70415,70416,0],[70419,70440,0],[70442,70448,0],[70450,70451,0],[70453,70457,0],[70461,70461,0],[70462,70463,0],[70465,70468,0],[70471,70472,0],[70475,70477,0],[70480,70480,0],[70487,70487,0],[70493,70497,0],[70498,70499,0],[70656,70708,0],[70709,70711,0],[70720,70721,0],[70725,70725,0],[70727,70730,0],[70731,70735,0],[70736,70745,0],[70746,70747,0],[70749,70749,0],[70751,70753,0],[70784,70831,0],[70832,70834,0],[70841,70841,0],[70843,70846,0],[70849,70849,0],[70852,70853,0],[70854,70854,0],[70855,70855,0],[70864,70873,0],[71040,71086,0],[71087,71089,0],[71096,71099,0],[71102,71102,0],[71105,71127,0],[71128,71131,0],[71168,71215,0],[71216,71218,0],[71227,71228,0],[71230,71230,0],[71233,71235,0],[71236,71236,0],[71248,71257,0],[71296,71338,0],[71340,71340,0],[71342,71343,0],[71350,71350,0],[71352,71352,0],[71353,71353,0],[71360,71369,0],[71424,71450,0],[71456,71457,0],[71462,71462,0],[71472,71481,0],[71482,71483,0],[71484,71486,0],[71487,71487,0],[71488,71494,0],[71680,71723,0],[71724,71726,0],[71736,71736,0],[71739,71739,0],[71840,71903,0],[71904,71913,0],[71914,71922,0],[71935,71942,0],[71945,71945,0],[71948,71955,0],[71957,71958,0],[71960,71983,0],[71984,71989,0],[71991,71992,0],[71997,71997,0],[71999,71999,0],[72000,72000,0],[72001,72001,0],[72002,72002,0],[72004,72006,0],[72016,72025,0],[72096,72103,0],[72106,72144,0],[72145,72147,0],[72156,72159,0],[72161,72161,0],[72162,72162,0],[72163,72163,0],[72164,72164,0],[72192,72192,0],[72199,72200,0],[72203,72242,0],[72249,72249,0],[72250,72250,0],[72255,72262,0],[72272,72272,0],[72279,72280,0],[72284,72329,0],[72343,72343,0],[72346,72348,0],[72349,72349,0],[72350,72354,0],[72368,72440,0],[72448,72457,0],[72704,72712,0],[72714,72750,0],[72751,72751,0],[72766,72766,0],[72767,72767,0],[72768,72768,0],[72769,72773,0],[72784,72793,0],[72794,72812,0],[72816,72817,0],[72818,72847,0],[72873,72873,0],[72881,72881,0],[72884,72884,0],[72960,72966,0],[72968,72969,0],[72971,73008,0],[73030,73030,0],[73040,73049,0],[73056,73061,0],[73063,73064,0],[73066,73097,0],[73098,73102,0],[73107,73108,0],[73110,73110,0],[73112,73112,0],[73120,73129,0],[73440,73458,0],[73461,73462,0],[73463,73464,0],[73474,73474,0],[73475,73475,0],[73476,73488,0],[73490,73523,0],[73524,73525,0],[73534,73535,0],[73537,73537,0],[73539,73551,0],[73552,73561,0],[73648,73648,0],[73664,73684,0],[73727,73727,0],[73728,74649,0],[74752,74862,0],[74864,74868,0],[74880,75075,0],[77712,77808,0],[77809,77810,0],[77824,78895,0],[78896,78911,0],[78913,78918,0],[82944,83526,0],[92160,92728,0],[92736,92766,0],[92768,92777,0],[92782,92783,0],[92784,92862,0],[92864,92873,0],[92880,92909,0],[92917,92917,0],[92928,92975,0],[92983,92987,0],[92988,92991,0],[92992,92995,0],[92996,92996,0],[92997,92997,0],[93008,93017,0],[93019,93025,0],[93027,93047,0],[93053,93071,0],[93760,93823,0],[93824,93846,0],[93847,93850,0],[93952,94026,0],[94032,94032,0],[94033,94087,0],[94099,94111,0],[94176,94177,0],[94179,94179,0],[94192,94193,0],[94208,100343,0],[100352,101589,0],[101632,101640,0],[110576,110579,0],[110581,110587,0],[110589,110590,0],[110592,110882,0],[110898,110898,0],[110928,110930,0],[110933,110933,0],[110948,110951,0],[110960,111355,0],[113664,113770,0],[113776,113788,0],[113792,113800,0],[113808,113817,0],[113820,113820,0],[113823,113823,0],[118608,118723,0],[118784,119029,0],[119040,119078,0],[119081,119140,0],[119141,119142,0],[119146,119148,0],[119149,119154,0],[119171,119172,0],[119180,119209,0],[119214,119272,0],[119488,119507,0],[119520,119539,0],[119648,119672,0],[119808,119892,0],[119894,119964,0],[119966,119967,0],[119970,119970,0],[119973,119974,0],[119977,119980,0],[119982,119993,0],[119995,119995,0],[119997,120003,0],[120005,120069,0],[120071,120074,0],[120077,120084,0],[120086,120092,0],[120094,120121,0],[120123,120126,0],[120128,120132,0],[120134,120134,0],[120138,120144,0],[120146,120485,0],[120488,120512,0],[120513,120513,0],[120514,120538,0],[120540,120570,0],[120571,120571,0],[120572,120596,0],[120598,120628,0],[120629,120629,0],[120630,120654,0],[120656,120686,0],[120687,120687,0],[120688,120712,0],[120714,120744,0],[120745,120745,0],[120746,120770,0],[120772,120779,0],[120832,121343,0],[121399,121402,0],[121453,121460,0],[121462,121475,0],[121477,121478,0],[121479,121483,0],[122624,122633,0],[122634,122634,0],[122635,122654,0],[122661,122666,0],[122928,122989,0],[123136,123180,0],[123191,123197,0],[123200,123209,0],[123214,123214,0],[123215,123215,0],[123536,123565,0],[123584,123627,0],[123632,123641,0],[124112,124138,0],[124139,124139,0],[124144,124153,0],[124896,124902,0],[124904,124907,0],[124909,124910,0],[124912,124926,0],[124928,125124,1],[125127,125135,1],[125184,125251,1],[125259,125259,1],[125264,125273,1],[125278,125279,1],[126065,126123,1],[126124,126124,1],[126125,126127,1],[126128,126128,1],[126129,126132,1],[126209,126253,1],[126254,126254,1],[126255,126269,1],[126464,126467,1],[126469,126495,1],[126497,126498,1],[126500,126500,1],[126503,126503,1],[126505,126514,1],[126516,126519,1],[126521,126521,1],[126523,126523,1],[126530,126530,1],[126535,126535,1],[126537,126537,1],[126539,126539,1],[126541,126543,1],[126545,126546,1],[126548,126548,1],[126551,126551,1],[126553,126553,1],[126555,126555,1],[126557,126557,1],[126559,126559,1],[126561,126562,1],[126564,126564,1],[126567,126570,1],[126572,126578,1],[126580,126583,1],[126585,126588,1],[126590,126590,1],[126592,126601,1],[126603,126619,1],[126625,126627,1],[126629,126633,1],[126635,126651,1],[127248,127278,0],[127280,127337,0],[127344,127404,0],[127462,127490,0],[127504,127547,0],[127552,127560,0],[127568,127569,0],[131072,173791,0],[173824,177977,0],[177984,178205,0],[178208,183969,0],[183984,191456,0],[191472,192093,0],[194560,195101,0],[196608,201546,0],[201552,205743,0],[983040,1048573,0],[1048576,1114109,0]]");
//#endregion
//#region src/text/bidi.ts
function paragraphDirection(text) {
	let isolates = 0;
	for (const char of text) {
		const cp = char.codePointAt(0);
		if (cp >= 8294 && cp <= 8296) {
			isolates++;
			continue;
		}
		if (cp === 8297) {
			isolates = Math.max(0, isolates - 1);
			continue;
		}
		if (isolates) continue;
		let lo = 0, hi = bidi_data_default.length - 1;
		while (lo <= hi) {
			const mid = lo + hi >>> 1, range = bidi_data_default[mid];
			if (cp < range[0]) hi = mid - 1;
			else if (cp > range[1]) lo = mid + 1;
			else return range[2] ? "rtl" : "ltr";
		}
	}
	return "ltr";
}
//#endregion
//#region src/text/memory.ts
var MiB = 1024 ** 2;
var MemoryPool = class {
	#cpu = 0;
	#text = 0;
	check(bytes, category = "text") {
		if (!Number.isSafeInteger(bytes) || bytes < 0) fail("TEXT_RESERVATION");
		if (this.#cpu + bytes > 512 * MiB || category === "text" && this.#text + bytes > 128 * MiB) fail("TEXT_MEMORY_BUDGET", {
			requested: bytes,
			cpu: this.#cpu,
			text: this.#text
		});
	}
	reserve(bytes, category = "text") {
		this.check(bytes, category);
		this.#cpu += bytes;
		if (category === "text") this.#text += bytes;
		let live = true;
		return Object.freeze({
			bytes,
			release: () => {
				if (!live) return;
				live = false;
				this.#cpu -= bytes;
				if (category === "text") this.#text -= bytes;
			}
		});
	}
	get snapshot() {
		return Object.freeze({
			cpuBytes: this.#cpu,
			textBytes: this.#text
		});
	}
};
new MemoryPool();
var ownedFonts = /* @__PURE__ */ new WeakSet();
function planText(request) {
	const { indices, total } = admitRequest(request);
	const glyphs = Math.max(64, indices.scalars * 8), runs = glyphs;
	const lines = Math.max(indices.lines, glyphs), rectangles = glyphs * 2;
	const layout = 16384 + (glyphs + indices.scalars + lines) * 1024;
	if (layout > LIMITS.layoutBytes) fail("TEXT_LAYOUT_BUDGET");
	const raster = Math.ceil(request.frame.width) * Math.ceil(request.frame.height) * 4;
	const indexes = (request.text.length + indices.bytes + indices.scalars + 3) * 128;
	const fonts = 4 * total - request.fonts.reduce((n, f) => n + (ownedFonts.has(f.bytes) ? f.bytes.size : 0), 0);
	const bytes = fonts + 4 * raster + 6 * layout + indexes + 65536;
	const startup = fonts - 2 * total + request.text.length * 4 + 65536;
	return Object.freeze({
		bytes,
		startup,
		glyphs,
		runs,
		lines,
		rectangles,
		layout,
		raster,
		fonts,
		indexes
	});
}
LIMITS.wasmBytes + 6 * profile_default.engine.wasm.bytes + 4 * MiB;
LIMITS.wasmBytes + 2 * profile_default.engine.wasm.bytes + 4 * MiB;
//#endregion
//#region src/text/core.ts
var fontCaches = /* @__PURE__ */ new WeakMap();
function suppliedFaces(ck, order, buffers) {
	let cache = fontCaches.get(ck);
	if (!cache) {
		cache = {
			provider: ck.TypefaceFontProvider.Make(),
			faces: []
		};
		fontCaches.set(ck, cache);
	}
	const missing = order.filter((hash) => !cache.faces.some((face) => face.hash === hash));
	if (cache.faces.length + missing.length > LIMITS.faces) fail("FONT_CACHE_CAPACITY");
	for (const hash of missing) {
		cache.provider.registerFont(buffers.get(hash), hash);
		const face = cache.provider.matchFamilyStyle(hash, {
			weight: ck.FontWeight.Normal,
			width: ck.FontWidth.Normal,
			slant: ck.FontSlant.Upright
		});
		if (!face) fail("FONT_NATIVE_PARSE", { hash });
		cache.faces.push({
			hash,
			face
		});
	}
	if (cache.provider.countFamilies() !== cache.faces.length) fail("FONT_NATIVE_PARSE");
	return {
		provider: cache.provider,
		faces: order.map((hash) => cache.faces.find((face) => face.hash === hash))
	};
}
function finite(value) {
	if (typeof value === "number" && !Number.isFinite(value)) fail("TEXT_NONFINITE_LAYOUT");
	if (value && typeof value === "object") Object.values(value).forEach(finite);
}
async function prepareText(request, ck, rendererProfile = profile_default.id) {
	const { order, total } = admitRequest(request);
	const indices = textIndices(request.text), plan = planText(request);
	const fontBuffers = /* @__PURE__ */ new Map();
	let glyphBudget = plan.glyphs, runBudget = plan.runs, lineBudget = plan.lines, rectBudget = plan.rectangles;
	const dependencies = [];
	for (const hash of order) {
		const font = request.fonts.find((f) => f.hash === hash);
		const bytes = await font.bytes.arrayBuffer();
		if (await hashBytes(bytes) !== hash) fail("FONT_HASH", { hash });
		const record = inspectFont(bytes);
		fontBuffers.set(hash, bytes);
		dependencies.push({
			hash,
			licenseHash: font.license.hash,
			faceIndex: 0,
			format: record.format,
			parserProfile: record.parserProfile,
			fsType: record.fsType,
			bytes: font.bytes
		});
	}
	const textUtf8 = new Blob([new TextEncoder().encode(request.text)], { type: "text/plain;charset=utf-8" });
	const textHash = await hashBytes(textUtf8);
	const s = request.style;
	const dependencyHash = await hashBytes(new TextEncoder().encode(JSON.stringify({
		rendererProfile,
		textHash,
		style: {
			primaryFont: s.primaryFont,
			explicitFallbacks: s.explicitFallbacks,
			sizePx: s.sizePx,
			lineHeightMultiplier: s.lineHeightMultiplier,
			fill: s.fill,
			align: s.align,
			direction: s.direction
		},
		frame: {
			width: request.frame.width,
			height: request.frame.height
		},
		fonts: dependencies.map(({ bytes: _bytes, ...d }) => d)
	})));
	const { provider, faces } = suppliedFaces(ck, order, fontBuffers);
	const collection = ck.FontCollection.Make();
	const width = Math.ceil(request.frame.width), height = Math.ceil(request.frame.height);
	let surface = null;
	let rasterMemory;
	const paragraphs = [];
	let top = 0, start16 = 0, overflow = false;
	try {
		collection.setDefaultFontManager(provider);
		rasterMemory = ck.Malloc(Uint8Array, width * height * 4);
		if (!rasterMemory.byteOffset) fail("TEXT_SURFACE_ALLOCATION");
		surface = ck.MakeRasterDirectSurface({
			width,
			height,
			colorType: ck.ColorType.RGBA_8888,
			alphaType: ck.AlphaType.Unpremul,
			colorSpace: ck.ColorSpace.SRGB
		}, rasterMemory, width * 4);
		if (!surface) fail("TEXT_SURFACE_ALLOCATION");
		const canvas = surface.getCanvas();
		canvas.clear(ck.TRANSPARENT);
		canvas.clipRect(ck.LTRBRect(0, 0, request.frame.width, request.frame.height), ck.ClipOp.Intersect, true);
		const { style } = request;
		const fontMetrics = faces.map(({ hash, face }) => {
			const font = new ck.Font(face, style.sizePx);
			try {
				font.setHinting(ck.FontHinting.None);
				return {
					hash,
					...font.getMetrics()
				};
			} finally {
				font.delete();
			}
		});
		const intrinsicHeight = Math.max(...fontMetrics.map((m) => m.descent - m.ascent + m.leading));
		const lineHeight = intrinsicHeight * style.lineHeightMultiplier;
		if (!Number.isFinite(lineHeight) || lineHeight <= 0 || lineHeight > LIMITS.side) fail("TEXT_LINE_HEIGHT_LIMIT");
		const align = {
			left: ck.TextAlign.Left,
			center: ck.TextAlign.Center,
			right: ck.TextAlign.Right,
			start: ck.TextAlign.Start,
			end: ck.TextAlign.End
		}[style.align];
		for (const text of request.text.split("\n")) {
			const local = textIndices(text), start8 = indices.utf16ToUtf8[start16];
			const direction = style.direction === "auto" ? paragraphDirection(text) : style.direction;
			const paragraphStyle = new ck.ParagraphStyle({
				disableHinting: true,
				applyRoundingHack: false,
				textAlign: align,
				textDirection: direction === "rtl" ? ck.TextDirection.RTL : ck.TextDirection.LTR,
				textStyle: {
					fontFamilies: order,
					fontSize: style.sizePx,
					fontStyle: {
						weight: ck.FontWeight.Normal,
						width: ck.FontWidth.Normal,
						slant: ck.FontSlant.Upright
					},
					heightMultiplier: lineHeight / style.sizePx,
					halfLeading: true,
					locale: "und",
					color: ck.Color(...style.fill.slice(0, 3), style.fill[3] / 255)
				}
			});
			const builder = ck.ParagraphBuilder.MakeFromFontCollection(paragraphStyle, collection);
			let paragraph;
			try {
				builder.addText(text);
				paragraph = builder.build();
				paragraph.layout(request.frame.width);
				const bounded = paragraph;
				const lineCount = paragraph.getNumberOfLines();
				if (lineCount > lineBudget) fail("TEXT_LAYOUT_BUDGET");
				lineBudget -= lineCount;
				const missing = paragraph.unresolvedCodepoints();
				if (missing.length) fail("TEXT_MISSING_GLYPHS", { codepoints: [...new Set(missing)].sort((a, b) => a - b) });
				const utf16 = (byte) => {
					if (!Number.isInteger(byte) || local.utf8ToUtf16[byte] === void 0 || local.utf8ToUtf16[byte] < 0) fail("TEXT_LAYOUT_INDEX", {
						byte,
						text,
						metrics: paragraph.getLineMetrics()
					});
					return start16 + local.utf8ToUtf16[byte];
				};
				const utf8 = (index) => {
					if (!Number.isInteger(index) || local.utf16ToUtf8[index] === void 0 || local.utf16ToUtf8[index] < 0) fail("TEXT_LAYOUT_INDEX", { index });
					return start8 + local.utf16ToUtf8[index];
				};
				const lines = paragraph.getLineMetrics().map((m) => ({
					baseline: m.baseline + top,
					ascent: m.ascent,
					descent: m.descent,
					height: m.height,
					width: m.width,
					left: m.left,
					lineNumber: m.lineNumber,
					isHardBreak: m.isHardBreak,
					startUtf8: utf8(m.startIndex),
					endUtf8: utf8(m.endIndex),
					startUtf16: start16 + m.startIndex,
					endUtf16: start16 + m.endIndex,
					endExcludingWhitespacesUtf16: start16 + m.endExcludingWhitespaces,
					endIncludingNewlineUtf16: start16 + m.endIncludingNewline,
					endExcludingWhitespacesUtf8: utf8(m.endExcludingWhitespaces),
					endIncludingNewlineUtf8: utf8(m.endIncludingNewline)
				}));
				const shaped = bounded.getShapedLinesBounded(glyphBudget, runBudget, lineCount);
				if (!shaped) fail("TEXT_LAYOUT_BUDGET");
				const runs = [];
				try {
					const missingRanges = /* @__PURE__ */ new Map();
					for (const line of shaped) for (const run of line.runs) for (let i = 0; i < run.glyphs.length; i++) if (run.glyphs[i] === 0) {
						const index = utf16(run.offsets[i]) - start16;
						const glyph = paragraph.getGlyphInfoAt(index);
						if (!glyph || glyph.isEllipsis) fail("TEXT_CLUSTER_UNAVAILABLE", { utf16: start16 + index });
						const { start, end } = glyph.graphemeClusterTextRange;
						if (!(start <= index && index < end)) fail("TEXT_CLUSTER_INDEX");
						const startUtf8 = utf8(start), endUtf8 = utf8(end);
						missingRanges.set(start, {
							startUtf16: start16 + start,
							endUtf16: start16 + end,
							startUtf8,
							endUtf8
						});
					}
					if (missingRanges.size) {
						const ranges = [...missingRanges.values()].sort((a, b) => a.startUtf16 - b.startUtf16);
						const codepoints = /* @__PURE__ */ new Set();
						let range = 0;
						for (const scalar of local.scalars) {
							const index = start16 + scalar.utf16;
							while (range < ranges.length && index >= ranges[range].endUtf16) range++;
							if (range < ranges.length && index >= ranges[range].startUtf16) codepoints.add(scalar.codepoint);
						}
						fail("TEXT_MISSING_GLYPHS", {
							codepoints: [...codepoints].sort((a, b) => a - b),
							ranges
						});
					}
					for (const line of shaped) for (const run of line.runs) {
						glyphBudget -= run.glyphs.length;
						runBudget--;
						const fontHash = faces.find((f) => run.typeface?.isAliasOf(f.face))?.hash;
						if (!fontHash) fail("TEXT_UNRESOLVED_RUN_FONT");
						if (run.fakeBold || run.fakeItalic) fail("TEXT_SYNTHETIC_FACE");
						const offsets = Array.from(run.offsets);
						const font = new ck.Font(run.typeface, run.size);
						let inkBounds;
						try {
							font.setHinting(ck.FontHinting.None);
							font.setSubpixel(true);
							const bounds = font.getGlyphBounds(run.glyphs);
							inkBounds = Array.from(run.glyphs, (_, i) => [
								bounds[i * 4] + run.positions[i * 2],
								bounds[i * 4 + 1] + run.positions[i * 2 + 1] + top,
								bounds[i * 4 + 2] + run.positions[i * 2],
								bounds[i * 4 + 3] + run.positions[i * 2 + 1] + top
							]);
						} finally {
							font.delete();
						}
						overflow ||= inkBounds.some(([l, t, r, b]) => r > l && b > t && (l < 0 || t < 0 || r > request.frame.width || b > request.frame.height));
						runs.push({
							fontHash,
							size: run.size,
							flags: run.flags,
							glyphs: Array.from(run.glyphs),
							offsetsUtf8: offsets.map((x) => x + start8),
							offsetsUtf16: offsets.map(utf16),
							positions: Array.from(run.positions, (v, i) => v + (i % 2 ? top : 0)),
							inkBounds,
							top: line.top + top,
							bottom: line.bottom + top,
							baseline: line.baseline + top
						});
					}
				} finally {
					for (const line of shaped) for (const run of line.runs) run.typeface?.delete();
				}
				const clusters = [], seen = /* @__PURE__ */ new Set();
				for (const scalar of local.scalars) {
					const glyph = paragraph.getGlyphInfoAt(scalar.utf16);
					if (!glyph || glyph.isEllipsis) fail("TEXT_CLUSTER_UNAVAILABLE", { utf16: start16 + scalar.utf16 });
					const { start, end } = glyph.graphemeClusterTextRange;
					if (local.utf16ToUtf8[start] === void 0 || local.utf16ToUtf8[start] < 0 || local.utf16ToUtf8[end] === void 0 || local.utf16ToUtf8[end] < 0) fail("TEXT_CLUSTER_INDEX");
					const key = start + ":" + end;
					if (seen.has(key)) continue;
					seen.add(key);
					const rects = bounded.getRectsForRangeBounded(start, end, ck.RectHeightStyle.Tight, ck.RectWidthStyle.Tight, rectBudget);
					if (!rects) fail("TEXT_LAYOUT_BUDGET");
					rectBudget -= rects.length / 5;
					const ranges = [];
					try {
						for (let i = 0; i < rects.length; i += 5) ranges.push({
							rect: [
								rects[i],
								rects[i + 1] + top,
								rects[i + 2],
								rects[i + 3] + top
							],
							direction: rects[i + 4] === 1 ? "ltr" : "rtl"
						});
					} finally {
						if (rects.length) ck._free(rects.byteOffset);
					}
					clusters.push({
						startUtf16: start16 + start,
						endUtf16: start16 + end,
						startUtf8: start8 + local.utf16ToUtf8[start],
						endUtf8: start8 + local.utf16ToUtf8[end],
						direction: glyph.dir.value === ck.TextDirection.RTL.value ? "rtl" : "ltr",
						rect: Array.from(glyph.graphemeLayoutBounds, (v, i) => v + (i % 2 ? top : 0)),
						ranges
					});
				}
				const paragraphHeight = paragraph.getHeight();
				paragraphs.push({
					startUtf16: start16,
					endUtf16: start16 + text.length,
					startUtf8: start8,
					endUtf8: start8 + local.bytes,
					top,
					height: paragraphHeight,
					direction,
					lines,
					runs,
					clusters
				});
				overflow ||= top + paragraphHeight > request.frame.height || lines.some((l) => l.left < 0 || l.left + l.width > request.frame.width);
				canvas.drawParagraph(paragraph, 0, top);
				top += paragraphHeight;
				start16 += text.length + 1;
			} finally {
				paragraph?.delete();
				builder.delete();
			}
		}
		surface.flush();
		const pixels = new Uint8Array(rasterMemory.toTypedArray());
		if (pixels.byteLength !== width * height * 4) fail("TEXT_READBACK");
		for (let i = 0; i < pixels.length; i += 4) if (!pixels[i + 3]) pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
		const layoutValue = {
			version: "layout-1",
			policy: "text-layout-1",
			frame: request.frame,
			indexConvention: "half-open; UTF-16 native; UTF-8 shaped offsets; -1 scalar interiors; downstream at start/upstream at end",
			utf16ToUtf8: indices.utf16ToUtf8,
			utf8ToUtf16: indices.utf8ToUtf16,
			lineHeightPolicy: "max-supplied-font-metrics-times-multiplier; symmetric-leading; native-rounded-baselines",
			fontMetrics: fontMetrics.map((m) => ({
				hash: m.hash,
				ascent: m.ascent,
				descent: m.descent,
				leading: m.leading
			})),
			intrinsicHeight,
			requestedLineHeight: lineHeight,
			logicalLines: indices.lines,
			paragraphs,
			height: top,
			overflow
		};
		finite(layoutValue);
		const layout = new Blob([JSON.stringify(layoutValue)], { type: "application/json" });
		if (layout.size > LIMITS.layoutBytes) fail("TEXT_LAYOUT_SIZE");
		const rgba = new Blob([pixels], { type: "application/octet-stream" });
		if (ck.HEAPU8.byteLength > LIMITS.wasmBytes) fail("TEXT_HEAP_LIMIT");
		return {
			kind: "prepared-text-1",
			token: request.token,
			rendererProfile,
			dependencyHash,
			dependencies,
			textUtf8,
			textHash,
			layout,
			layoutHash: await hashBytes(layout),
			rgba,
			rasterHash: await hashBytes(rgba),
			width,
			height,
			overflow,
			allocation: {
				wasmHeapBytes: ck.HEAPU8.byteLength,
				uniqueFontBytes: total,
				rasterBytes: rgba.size,
				layoutBytes: layout.size,
				gpuBytes: 0
			}
		};
	} finally {
		surface?.delete();
		if (rasterMemory?.byteOffset) ck.Free(rasterMemory);
		collection.delete();
		ck.purgeOwnedTextCaches();
	}
}
//#endregion
//#region server/text/render-worker.mjs
var require = createRequire(import.meta.url);
var hash = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
var sealed = (path, entry) => {
	const b = readFileSync(path);
	if (b.length !== entry.bytes || hash(b) !== "sha256:" + entry.sha256) throw Error("TEXT_ENGINE_HASH");
	return b;
};
try {
	sealed(require.resolve("canvaskit-wasm"), profile_default.engine.js);
	const wasm = sealed(require.resolve("canvaskit-wasm/bin/canvaskit.wasm"), profile_default.engine.wasm);
	const module = new WebAssembly.Module(wasm), memoryName = WebAssembly.Module.exports(module).find((e) => e.kind === "memory")?.name;
	if (!memoryName) throw Error("TEXT_ENGINE_ABI");
	const ck = await require("canvaskit-wasm")({ instantiateWasm(imports, receive) {
		const instance = new WebAssembly.Instance(module, imports);
		if (instance.exports[memoryName].buffer.byteLength !== 16777216) throw Error("TEXT_HEAP_PROFILE");
		receive(instance);
		return instance.exports;
	} });
	if (ck.ParagraphBuilder.RequiresClientICU()) throw Error("TEXT_UNICODE_PROFILE");
	parentPort.postMessage({ type: "ready" });
	await new Promise((resolve) => parentPort.once("message", resolve));
	const fonts = workerData.fonts.map((f) => {
		const bytes = readFileSync(f.path);
		if (bytes.length !== f.length || hash(bytes) !== f.hash) throw Error("FONT_HASH");
		return {
			hash: f.hash,
			bytes: new Blob([bytes]),
			faceIndex: 0,
			origin: f.origin,
			license: {
				hash: f.licenseHash,
				embedding: "permitted"
			}
		};
	});
	const p = await prepareText({
		...workerData.request,
		fonts
	}, ck, workerData.profile ?? profile_default.id);
	if (workerData.expected) {
		const layout = readFileSync(workerData.expected.layoutPath);
		if (hash(layout) !== workerData.expected.layoutHash || canonical(JSON.parse(layout)) !== canonical(JSON.parse(await p.layout.text())) || p.rasterHash !== workerData.expected.pixelsHash || p.textHash !== workerData.expected.textHash || p.overflow !== workerData.expected.overflow) throw Error("TEXT_NATIVE_MISMATCH");
	}
	parentPort.postMessage(workerData.expected ? {
		type: "result",
		verified: true
	} : {
		type: "result",
		layout: await p.layout.text(),
		layoutHash: p.layoutHash,
		rasterHash: p.rasterHash,
		textHash: p.textHash,
		width: p.width,
		height: p.height,
		overflow: p.overflow,
		heapBytes: ck.HEAPU8.byteLength
	});
} catch (e) {
	parentPort.postMessage({
		type: "failure",
		code: e.code ?? e.message,
		details: e.details
	});
} finally {
	parentPort.close();
}
//#endregion
export {};
