import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { isSharedLearningRequest, isSharedLearningTurn, withSharedLearning } from "../src/server/shared-learning.ts";
import { fileAccessPolicy } from "../src/server/file-access.ts";

const { readSharedConfig, startSharedLearning } = createRequire(import.meta.url)("../electron/shared-learning.cjs");
const origin = new URL("https://workstation.example");

async function bind(server: http.Server) {
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

function send(port: number, resource: string, method = "GET", headers: IncomingHttpHeaders = {}, body?: string) {
	return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const request = http.request({ host: "127.0.0.1", port, path: resource, method, agent: false, headers: { host: origin.host, ...headers } }, response => {
			let content = "";
			response.setEncoding("utf8");
			response.on("data", chunk => { content += chunk; });
			response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: content }));
			response.on("error", reject);
		});
		request.on("error", reject);
		request.end(body);
	});
}

test("shared learning config defaults to disabled and requires TLS for a non-loopback bind", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-shared-config-"));
	try {
		assert.equal(readSharedConfig(directory), null);
		const file = path.join(directory, "shared-learning.json");
		await writeFile(file, JSON.stringify({ origin: origin.origin, port: 18443 }));
		assert.equal(readSharedConfig(directory).address, "127.0.0.1");
		await writeFile(file, JSON.stringify({ origin: origin.origin, port: 18443, bindAddress: "10.10.10.1" }));
		assert.throws(() => readSharedConfig(directory), /requires a certificate/);
		await writeFile(file, JSON.stringify({ origin: "http://workstation.example", port: 18443 }));
		assert.throws(() => readSharedConfig(directory), /HTTPS/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("the shared gateway pairs once, streams the local engine, and preserves authorized sessions over restart", async () => {
	const secret = randomBytes(32).toString("hex");
	const signingKey = randomBytes(32);
	const calls: { path?: string; headers: IncomingHttpHeaders }[] = [];
	const engine = http.createServer((req, res) => {
		calls.push({ path: req.url, headers: req.headers });
		res.setHeader("content-type", "text/event-stream");
		res.setHeader("set-cookie", "internal=value");
		res.write("data: progress\n\n");
		setImmediate(() => res.end("data: complete\n\n"));
	});
	const enginePort = await bind(engine);
	const portChooser = http.createServer();
	const port = await bind(portChooser);
	await new Promise<void>(resolve => portChooser.close(() => resolve()));
	const launch = () => startSharedLearning({ origin, port, address: "127.0.0.1" }, {
		upstream: `http://127.0.0.1:${enginePort}`, desktopSecret: secret, signingKey,
	});
	let gateway;
	try {
		gateway = await launch();
		assert.equal((await send(port, "/")).headers.location, "/_lh-share/login");
		assert.equal((await send(port, "/_lh-share/login")).headers["referrer-policy"], "same-origin");
		assert.equal((await send(port, "/api/chats", "GET", { "x-learnharness-desktop": secret })).status, 401);
		assert.equal(calls.length, 0);
		const code = gateway.makeCode();
		const headers = { origin: origin.origin, "content-type": "application/x-www-form-urlencoded" };
		assert.equal((await send(port, "/_lh-share/login", "POST", { ...headers, origin: "https://other.example" }, `code=${code}`)).status, 403);
		const signIn = await send(port, "/_lh-share/login", "POST", headers, `code=${code}`);
		assert.equal(signIn.status, 303);
		const loginCookie = signIn.headers["set-cookie"]?.[0];
		assert.ok(loginCookie);
		assert.match(loginCookie, /HttpOnly; Secure; SameSite=Strict/);
		const reused = await send(port, "/_lh-share/login", "POST", headers, `code=${code}`);
		assert.equal(reused.status, 303);
		assert.equal(reused.headers.location, "/_lh-share/login?retry=1");
		const retry = await send(port, reused.headers.location);
		assert.equal(retry.status, 200);
		assert.match(retry.body, /code is invalid or expired/);
		const session = { cookie: loginCookie.split(";", 1)[0] };
		assert.equal((await send(port, "/api/keys", "GET", session)).status, 403);
		assert.equal((await send(port, "/api/settings/agent", "PUT", { ...session, ...headers })).status, 403);
		assert.equal((await send(port, "/api/chats/../keys", "GET", session)).status, 400);
		assert.equal((await send(port, "/api/chats/%2e%2e/keys", "GET", session)).status, 400);
		assert.equal((await send(port, "/api/chat", "POST", session, "{}")).status, 403);
		const stream = await send(port, "/api/chat", "POST", { ...session, ...headers, "x-learnharness-desktop": "untrusted", authorization: "private" }, "{}");
		assert.equal(stream.body, "data: progress\n\ndata: complete\n\n");
		assert.equal(stream.headers["set-cookie"], undefined);
		assert.equal(stream.headers["cache-control"], "private, no-store");
		assert.equal(calls[0]?.headers["x-learnharness-desktop"], secret);
		assert.equal(calls[0]?.headers["x-learnharness-shared"], "1");
		assert.equal(calls[0]?.headers.cookie, undefined);
		assert.equal(calls[0]?.headers.authorization, undefined);
		gateway.close();
		gateway = await launch();
		assert.equal((await send(port, "/api/chats/chat_test/stream", "GET", session)).status, 200);
	} finally {
		gateway?.close();
		engine.closeAllConnections();
		await new Promise<void>(resolve => engine.close(() => resolve()));
	}
});

test("a trusted shared turn uses its own file access scope", async () => {
	const originalMode = process.env.LH_DESKTOP_SERVER;
	const originalSecret = process.env.LH_DESKTOP_API_SECRET;
	const secret = randomBytes(32).toString("hex");
	try {
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = secret;
		const shared = new Request("http://127.0.0.1/api/chat", { headers: { "x-learnharness-shared": "1", "x-learnharness-desktop": secret } });
		assert.equal(isSharedLearningRequest(new Headers({ "x-learnharness-shared": "1" })), false);
		assert.equal(isSharedLearningTurn(), false);
		await withSharedLearning(shared, async () => {
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(fileAccessPolicy(), { restricted: true, folders: [] });
		});
		assert.equal(isSharedLearningTurn(), false);
	} finally {
		if (originalMode === undefined) delete process.env.LH_DESKTOP_SERVER;
		else process.env.LH_DESKTOP_SERVER = originalMode;
		if (originalSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET;
		else process.env.LH_DESKTOP_API_SECRET = originalSecret;
	}
});
