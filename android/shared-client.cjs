"use strict";

const { createHash, X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { checkServerIdentity } = require("node:tls");

const COOKIE = "__Host-lh-shared";
const LOGIN = "/_lh-share/login";
const PAIRING_CODE = /^[A-Za-z0-9_-]{24}$/;
const FORWARD = new Set([
	"accept", "accept-encoding", "accept-language", "content-length", "content-type", "user-agent",
	"rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url",
]);

function pairingRequired(response) {
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8", "cache-control": "no-store",
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
	});
	response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to your PC</title>
<style>html{color-scheme:light dark}body{margin:8vh auto;padding:24px;max-width:28rem;font:16px/1.5 system-ui}a{display:inline-block;padding:12px 0}</style>
<h1>Connect to your PC</h1><p>Export a new, unused connection file on your PC and choose it here. The file is valid for five minutes.</p>
<a href="/_lh-client/settings">Choose another connection file</a></html>`);
}

function unavailable(response) {
	if (response.destroyed || response.writableEnded) return;
	if (response.headersSent) { response.destroy(); return; }
	response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	response.end("Cannot connect to the PC. Check the company VPN and the PC's certificate.");
}

function createSharedClient(connectionFile) {
	const source = fs.readFileSync(connectionFile, "utf8");
	const config = JSON.parse(source.replace(/^\uFEFF/, ""));
	const target = new URL(config.origin);
	if (![1, 2].includes(config.version) || target.protocol !== "https:" || target.username || target.password ||
		target.pathname !== "/" || target.search || target.hash || typeof config.certificate !== "string") {
		throw new Error("Invalid LearnHarness PC connection file");
	}
	// Passing an explicit CA list replaces the default trust anchors. The
	// HTTPS stack still validates the certificate lifetime and IP/DNS SAN.
	const pinned = new X509Certificate(config.certificate).fingerprint256;
	const agent = new https.Agent({
		ca: config.certificate, minVersion: "TLSv1.2", allowPartialTrustChain: true, keepAlive: true,
		checkServerIdentity(hostname, certificate) {
			const error = checkServerIdentity(hostname, certificate);
			if (error) return error;
			if (certificate.fingerprint256 !== pinned) return new Error("The PC certificate changed. Import a new LearnHarness connection file.");
		},
	});
	const identity = createHash("sha256").update(target.origin).update("\0").update(config.certificate).digest("hex");
	const directory = path.dirname(connectionFile);
	const sessionFile = path.join(directory, `shared-session-${identity}`);
	const usePairingFile = config.version === 2;
	let pendingFile;
	let pendingCode;
	if (usePairingFile) {
		if (typeof config.pairingId !== "string" || !/^[0-9a-f-]{36}$/.test(config.pairingId)) throw new Error("Invalid LearnHarness pairing reference");
		pendingFile = path.join(directory, `shared-pairing-${config.pairingId}.json`);
		try {
			const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
			if (typeof pending.code !== "string" || !PAIRING_CODE.test(pending.code)) throw new Error("Invalid LearnHarness pairing authorization");
			pendingCode = pending.code;
		} catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	let session = "";
	try { session = fs.readFileSync(sessionFile, "utf8"); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	const valid = /^__Host-lh-shared=\d{10}\.[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/;
	if (!valid.test(session)) session = "";
	const saveSession = value => {
		const temporary = `${sessionFile}.tmp`;
		fs.writeFileSync(temporary, value, { mode: 0o600 });
		fs.renameSync(temporary, sessionFile);
		session = value;
	};
	const getSessionCookie = headers => headers["set-cookie"]?.find(value => value.startsWith(COOKIE + "="))?.split(";", 1)[0];

	function redeemCode(code) {
		return new Promise((resolve, reject) => {
			const body = new URLSearchParams({ code }).toString();
			const call = https.request(target, {
				agent, path: LOGIN, method: "POST",
				headers: { origin: target.origin, "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) },
			}, result => {
				result.resume();
				const location = URL.parse(result.headers.location ?? "", target);
				const cookie = getSessionCookie(result.headers);
				try {
					if (result.statusCode !== 303 || location?.origin !== target.origin) throw new Error("Unexpected pairing response");
					if (location.pathname === "/" && cookie && valid.test(cookie)) saveSession(cookie);
					else if (location.pathname !== LOGIN || location.searchParams.get("retry") !== "1") throw new Error("Unexpected pairing response");
					pendingCode = undefined;
					fs.rmSync(pendingFile, { force: true });
					resolve();
				} catch (error) { reject(error); }
			});
			const timeout = setTimeout(() => call.destroy(new Error("PC pairing timed out")), 15_000);
			call.once("close", () => clearTimeout(timeout));
			call.once("error", reject);
			call.end(body);
		});
	}
	let enrollment;
	async function handle(request, response) {
		if (!request.url?.startsWith("/") || request.url.startsWith("//") || request.url.includes("\\")) {
			response.writeHead(400).end();
			return;
		}
		if (pendingCode) {
			enrollment ??= redeemCode(pendingCode).finally(() => { enrollment = undefined; });
			await enrollment;
			if (response.destroyed) return;
		}
		if (usePairingFile && (request.method === "GET" || request.method === "HEAD") &&
			!request.url.startsWith("/api/") && (!session || request.url.split("?", 1)[0] === LOGIN)) {
			pairingRequired(response);
			return;
		}
		const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => FORWARD.has(name)));
		if (session) headers.cookie = session;
		if (request.method !== "GET" && request.method !== "HEAD") headers.origin = target.origin;
		const upstream = https.request(target, { agent, method: request.method, path: request.url, headers }, result => {
			const forwarded = { ...result.headers };
			try {
				const value = getSessionCookie(forwarded);
				if (value === COOKIE + "=" || (value && valid.test(value))) saveSession(value === COOKIE + "=" ? "" : value);
			} catch {
				result.resume();
				unavailable(response);
				return;
			}
			for (const name of ["set-cookie", "connection", "keep-alive", "transfer-encoding", "strict-transport-security"]) delete forwarded[name];
			if (forwarded.location) {
				const location = URL.parse(forwarded.location, target);
				if (!location || location.origin !== target.origin) {
					result.resume();
					unavailable(response);
					return;
				}
				if (usePairingFile && location.pathname === LOGIN) {
					result.resume();
					pairingRequired(response);
					return;
				}
				forwarded.location = location.pathname + location.search + location.hash;
			}
			response.writeHead(result.statusCode, forwarded);
			result.on("error", () => response.destroy());
			result.pipe(response);
		});
		const connectTimeout = setTimeout(() => upstream.destroy(new Error("PC connection timed out")), 15_000);
		upstream.once("socket", socket => {
			if (socket.connecting) socket.once("secureConnect", () => clearTimeout(connectTimeout));
			else clearTimeout(connectTimeout);
		});
		upstream.once("close", () => clearTimeout(connectTimeout));
		upstream.on("error", () => unavailable(response));
		response.once("close", () => upstream.destroy());
		request.on("error", () => upstream.destroy());
		request.pipe(upstream);
	}
	return (request, response) => { void handle(request, response).catch(() => unavailable(response)); };
}

module.exports = { createSharedClient };
