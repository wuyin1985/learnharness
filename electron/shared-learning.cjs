"use strict";

const { createHash, createHmac, randomBytes, timingSafeEqual, X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { isIP } = require("node:net");
const path = require("node:path");

const LOGIN = "/_lh-share/login";
const LOGOUT = "/_lh-share/logout";
const COOKIE = "__Host-lh-shared";
const SESSION_TTL = 7 * 24 * 60 * 60;
const CODE_TTL = 5 * 60_000;
const LEARNING_HEADER = "x-learnharness-shared";
const DESKTOP_HEADER = "x-learnharness-desktop";
const UPSTREAM_HEADER_NAMES = new Set([
	"accept", "accept-encoding", "accept-language", "content-length", "content-type", "user-agent",
	"rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url",
]);
const PRIVATE_HEADERS = {
	"cache-control": "private, no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
};
const LOGIN_HEADERS = {
	...PRIVATE_HEADERS,
	"content-type": "text/html; charset=utf-8",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/** The filter and the desktop capability cover separate trust boundaries.
 * Keep the allowlist at the ingress, including method and canonical path. */
function allowedRequest(method, pathname) {
	if (method === "GET" || method === "HEAD") {
		return pathname === "/" || pathname === "/favicon.ico" ||
			/^\/_next\/static\/[\w./-]+$/.test(pathname) ||
			/^\/(?:fonts|siwc)\/[\w./-]+$/.test(pathname) ||
			/^\/chat\/[\w-]+$/.test(pathname) ||
			/^\/api\/(?:chats|events|activity|jobs|models|themes|graph(?:\/(?:status|costs|sources|render-settings))?)$/.test(pathname) ||
			/^\/api\/chats\/[\w-]+(?:\/(?:stream|settings|images\/[0-9a-f]{64}))?$/.test(pathname);
	}
	return method === "POST" && ["/api/chat", "/api/chats", "/api/activity/abort"].includes(pathname);
}

function routePath(raw) {
	if (!raw || !/^\/[\w./-]*(?:\?[^#]*)?$/.test(raw)) return null;
	const pathname = raw.split("?", 1)[0];
	if (pathname.includes("//") || pathname.split("/").some(part => part === "." || part === "..")) return null;
	return pathname;
}

function readSharedConfig(profile, configuredPath = path.join(profile, "shared-learning.json")) {
	let raw;
	try { raw = fs.readFileSync(configuredPath, "utf8"); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
	const config = JSON.parse(raw.replace(/^\uFEFF/, ""));
	if (!config || typeof config !== "object" || typeof config.origin !== "string") throw new Error("Shared Learning needs an HTTPS origin.");
	const origin = new URL(config.origin);
	if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
		throw new Error("Shared Learning origin must be an HTTPS address without credentials or a path.");
	}
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
		throw new Error("Shared Learning port must be between 1 and 65535.");
	}
	if (config.tls === undefined) {
		if (config.bindAddress !== undefined && config.bindAddress !== "127.0.0.1") throw new Error("A non-loopback listener requires a certificate and private key.");
		return { origin, port: config.port, address: "127.0.0.1", tls: null };
	}
	if (isIP(config.bindAddress) !== 4 || config.bindAddress === "0.0.0.0" ||
		Number(origin.port || "443") !== config.port ||
		typeof config.tls?.certificate !== "string" || typeof config.tls?.key !== "string") {
		throw new Error("Direct HTTPS requires a specific IPv4 bind address, matching port, certificate, and key.");
	}
	const readPem = name => fs.readFileSync(path.resolve(path.dirname(configuredPath), name));
	const cert = readPem(config.tls.certificate);
	const leaf = new X509Certificate(cert);
	const host = origin.hostname;
	if (!(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: "never" })) ||
		Date.parse(leaf.validTo) <= Date.now() || Date.parse(leaf.validFrom) > Date.now()) {
		throw new Error("The TLS certificate must be valid for the configured HTTPS address.");
	}
	return { origin, port: config.port, address: config.bindAddress, tls: { cert, key: readPem(config.tls.key), minVersion: "TLSv1.2" } };
}

function loadSigningKey(profile, safeStorage) {
	const file = path.join(profile, "shared-learning-key");
	if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS credential store is unavailable.");
	try {
		const key = safeStorage.decryptString(fs.readFileSync(file));
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("The shared learning key is invalid.");
		return Buffer.from(key, "hex");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const key = randomBytes(32);
		const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
		try {
			fs.writeFileSync(temporary, safeStorage.encryptString(key.toString("hex")), { flag: "wx", mode: 0o600 });
			fs.renameSync(temporary, file);
		} finally { fs.rmSync(temporary, { force: true }); }
		return key;
	}
}

function reply(res, status, body = "", headers = {}) {
	res.writeHead(status, { ...PRIVATE_HEADERS, "content-type": "text/plain; charset=utf-8", ...headers });
	res.end(body);
}

function loginPage(res, error = "") {
	reply(res, error ? 401 : 200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LearnHarness sign-in</title>
<style>html{color-scheme:light dark}body{margin:8vh auto;padding:24px;max-width:28rem;font:16px/1.5 system-ui}label,input,button{display:block}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;font:inherit}input{border:1px solid;border-radius:6px}button{min-height:48px}h1{margin-bottom:8px}</style>
<h1>LearnHarness</h1><p>Enter the sign-in code from LearnHarness on your PC.</p>${error ? `<p role="alert">${error}</p>` : ""}
<form method="post" action="${LOGIN}"><label for="code">Sign-in code</label><input id="code" name="code" type="password" maxlength="64" autocapitalize="off" autocomplete="off" required><button type="submit">Connect</button></form></html>`, LOGIN_HEADERS);
}

async function readCode(req) {
	if (req.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") return null;
	let body = "";
	for await (const chunk of req) {
		body += chunk.toString("utf8");
		if (body.length > 256) return null;
	}
	return new URLSearchParams(body).get("code")?.trim() ?? null;
}

function bounce(res, location, options = {}) {
	reply(res, 303, "", { location, ...options });
}

function safeProxy(req, res, engine, desktopSecret, publicOrigin) {
	const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => UPSTREAM_HEADER_NAMES.has(name)));
	headers.host = engine.host;
	headers[DESKTOP_HEADER] = desktopSecret;
	headers[LEARNING_HEADER] = "1";
	const upstream = http.request(engine, { method: req.method, path: req.url, headers }, response => {
		const forwarded = { ...response.headers, ...PRIVATE_HEADERS };
		for (const name of ["set-cookie", "connection", "keep-alive", "transfer-encoding", "x-middleware-set-cookie", "x-powered-by"]) delete forwarded[name];
		if (forwarded.location) {
			const target = URL.parse(forwarded.location, engine);
			if (!target || target.origin !== engine.origin) {
				response.resume();
				reply(res, 502, "LearnHarness returned a redirect outside the shared service.");
				return;
			}
			forwarded.location = new URL(target.pathname + target.search + target.hash, publicOrigin).href;
		}
		res.writeHead(response.statusCode, forwarded);
		response.on("error", () => res.destroy());
		response.pipe(res);
	});
	upstream.on("error", () => {
		if (!res.headersSent) reply(res, 503, "The PC learning engine is unavailable. Try again shortly.");
		else res.destroy();
	});
	res.once("close", () => upstream.destroy());
	req.on("error", () => upstream.destroy());
	req.pipe(upstream);
}

async function startSharedLearning(config, { upstream, desktopSecret, signingKey }) {
	const engine = new URL(upstream);
	if (engine.protocol !== "http:" || engine.hostname !== "127.0.0.1" || !desktopSecret || signingKey?.length !== 32) {
		throw new Error("Shared Learning requires a private local engine and signing key.");
	}
	let codeDigest = null;
	let codeExpires = 0;
	let attempts = 0;
	const digest = text => createHash("sha256").update(text).digest();
	const sign = value => createHmac("sha256", signingKey).update(config.origin.origin).update("\0").update(value).digest();
	const cookie = (value, age) => `${COOKIE}=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Strict`;
	const validSession = header => {
		const session = header?.split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
		const parts = session?.match(/^(\d{10})\.([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/);
		if (!parts || Number(parts[1]) <= Math.floor(Date.now() / 1000)) return false;
		const mac = Buffer.from(parts[3], "base64url");
		return mac.length === 32 && timingSafeEqual(sign(`${parts[1]}.${parts[2]}`), mac);
	};
	const handle = async (req, res) => {
		const pathname = routePath(req.url);
		if (!pathname || req.headers.host?.toLowerCase() !== config.origin.host) return reply(res, 400, "Invalid shared service address.");
		if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin !== config.origin.origin) {
			return reply(res, 403, "Use the shared LearnHarness address to submit requests.");
		}
		if (pathname === LOGIN) {
			if (req.method === "GET") return loginPage(res);
			if (req.method !== "POST") return reply(res, 405, "Method not allowed.");
			const submitted = await readCode(req);
			if (!submitted || !codeDigest || Date.now() >= codeExpires || ++attempts > 8 || !timingSafeEqual(codeDigest, digest(submitted))) {
				return loginPage(res, "This code is invalid or expired. Generate a new code on your PC.");
			}
			codeDigest = null;
			const value = `${Math.floor(Date.now() / 1000) + SESSION_TTL}.${randomBytes(18).toString("base64url")}`;
			return bounce(res, "/", { "set-cookie": cookie(`${value}.${sign(value).toString("base64url")}`, SESSION_TTL) });
		}
		if (!validSession(req.headers.cookie)) {
			return pathname.startsWith("/api/") ? reply(res, 401, "Sign in to the shared LearnHarness first.") : bounce(res, LOGIN);
		}
		if (pathname === LOGOUT && req.method === "POST") return bounce(res, LOGIN, { "set-cookie": cookie("", 0) });
		if (!allowedRequest(req.method, pathname)) return reply(res, 403, "This action is available on the PC.");
		safeProxy(req, res, engine, desktopSecret, config.origin);
	};
	const listener = (req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) reply(res, 400, "Invalid request."); else res.destroy(); }); };
	const server = config.tls ? https.createServer(config.tls, listener) : http.createServer(listener);
	server.requestTimeout = 30_000;
	server.on("upgrade", (_request, socket) => socket.destroy());
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.address, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return {
		url: config.origin.origin,
		pairing: config.tls ? { version: 1, origin: config.origin.origin, certificate: config.tls.cert.toString("utf8") } : null,
		makeCode() {
			const code = randomBytes(18).toString("base64url");
			codeDigest = digest(code);
			codeExpires = Date.now() + CODE_TTL;
			attempts = 0;
			return code;
		},
		close() { server.close(); server.closeAllConnections(); },
	};
}

module.exports = { allowedRequest, loadSigningKey, readSharedConfig, routePath, startSharedLearning };
