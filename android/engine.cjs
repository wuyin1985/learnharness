"use strict";

const { timingSafeEqual } = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");
const { registerHooks } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const host = "127.0.0.1";
const session = process.env.LH_ANDROID_TOKEN;
const readyPort = Number(process.env.LH_ANDROID_PORT ?? 0);

function authorized(request, port) {
	if (request.headers.host !== `${host}:${port}`) return false;
	const origin = request.headers.origin;
	if (origin && origin !== `http://${host}:${port}`) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const cookie = request.headers.cookie?.split(";").map((value) => value.trim())
		.find((value) => value.startsWith("lh_android="))?.slice("lh_android=".length);
	return typeof cookie === "string" && /^[a-f0-9]{64}$/.test(cookie)
		&& timingSafeEqual(Buffer.from(cookie), Buffer.from(session));
}

async function start() {
	if (!/^[a-f0-9]{64}$/.test(session ?? "")) throw new Error("Missing Android session token");
	// The generated standalone config and router are the same ones used by
	// server.js. Insert the device capability before any Next routing, including
	// static assets and streaming routes, on a single loopback listener.
	const dir = __dirname;
	process.chdir(dir);
	process.env.NODE_ENV = "production";
	process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(require("./android-next-config.json"));
	if (!process.features.inspector) {
		// Next's production logging probes inspector.url(). Node Mobile ships
		// without the debugger; answer these probes inside the bundled framework.
		const nextPath = pathToFileURL(path.join(dir, "node_modules/next") + path.sep).href;
		const shim = pathToFileURL(path.join(dir, "inspector.cjs")).href;
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if ((specifier === "inspector" || specifier === "node:inspector") && context.parentURL?.startsWith(nextPath)) {
					return { url: shim, format: "commonjs", shortCircuit: true };
				}
				return nextResolve(specifier, context);
			},
		});
	}
	const { getRequestHandlers } = require("next/dist/server/lib/start-server");
	let handle;
	const server = http.createServer((request, response) => {
		if (!authorized(request, server.address().port)) {
			response.writeHead(403, { "Cache-Control": "no-store" }).end();
			return;
		}
		if (!handle) {
			response.writeHead(503, { "Cache-Control": "no-store" }).end();
			return;
		}
		Promise.resolve(handle(request, response)).catch((error) => {
			console.error("LearnHarness route failed:", error);
			if (response.headersSent) response.destroy();
			else response.writeHead(500).end();
		});
	});
	server.on("upgrade", (_request, socket) => socket.destroy());
	async function listen(port) {
		server.listen(port, host);
		await once(server, "listening");
	}
	try {
		await listen(readyPort);
	} catch (error) {
		if (error.code !== "EADDRINUSE" || readyPort === 0) throw error;
		await listen(0);
	}
	const { port } = server.address();
	const handlers = await getRequestHandlers({ dir, port, hostname: host, server, isDev: false });
	handle = handlers.requestHandler;
	console.log(`LH_ANDROID_READY ${port}`);
}

start().catch((error) => {
	console.error("Could not start LearnHarness:", error.stack ?? error);
	process.exit(1);
});
