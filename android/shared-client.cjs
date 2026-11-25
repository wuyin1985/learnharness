"use strict";

const { createHash, X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { checkServerIdentity } = require("node:tls");

const COOKIE = "__Host-lh-shared";
const FORWARD = new Set([
	"accept", "accept-encoding", "accept-language", "content-length", "content-type", "user-agent",
	"rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url",
]);

function createSharedClient(connectionFile) {
	const source = fs.readFileSync(connectionFile, "utf8");
	const config = JSON.parse(source.replace(/^\uFEFF/, ""));
	const target = new URL(config.origin);
	if (config.version !== 1 || target.protocol !== "https:" || target.username || target.password ||
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
	const sessionFile = path.join(path.dirname(connectionFile), `shared-session-${identity}`);
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

	return (request, response) => {
		if (!request.url?.startsWith("/") || request.url.startsWith("//") || request.url.includes("\\")) {
			response.writeHead(400).end();
			return;
		}
		const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => FORWARD.has(name)));
		if (session) headers.cookie = session;
		if (request.method !== "GET" && request.method !== "HEAD") headers.origin = target.origin;
		const unavailable = () => {
			if (response.headersSent) { response.destroy(); return; }
			response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			response.end("Cannot connect to the PC. Check the company VPN and the PC's certificate.");
		};
		const upstream = https.request(target, { agent, method: request.method, path: request.url, headers }, result => {
			const forwarded = { ...result.headers };
			try {
				const setCookie = forwarded["set-cookie"]?.find(value => value.startsWith(COOKIE + "="));
				if (setCookie) {
					const value = setCookie.split(";", 1)[0];
					if (value === COOKIE + "=" || valid.test(value)) saveSession(value === COOKIE + "=" ? "" : value);
				}
			} catch {
				result.resume();
				unavailable();
				return;
			}
			for (const name of ["set-cookie", "connection", "keep-alive", "transfer-encoding", "strict-transport-security"]) delete forwarded[name];
			if (forwarded.location) {
				const location = URL.parse(forwarded.location, target);
				if (!location || location.origin !== target.origin) {
					result.resume();
					unavailable();
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
		upstream.on("error", unavailable);
		response.once("close", () => upstream.destroy());
		request.on("error", () => upstream.destroy());
		request.pipe(upstream);
	};
}

module.exports = { createSharedClient };
