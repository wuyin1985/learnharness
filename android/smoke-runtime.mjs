import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const runtime = process.argv[2];
if (!runtime) throw new Error("Pass the directory extracted from runtime.zip.");
const profile = await mkdtemp(path.join(tmpdir(), "learnharness-android-smoke-"));
const token = randomBytes(32).toString("hex");
const engine = spawn(process.execPath, ["engine.cjs"], {
	cwd: path.resolve(runtime),
	stdio: ["ignore", "pipe", "inherit"],
	env: {
		SystemRoot: process.env.SystemRoot,
		NEXT_TELEMETRY_DISABLED: "1",
		LH_ANDROID_TOKEN: token,
		LH_ANDROID_ATTACHMENTS: path.join(profile, "attachments"),
		LH_DATA_DIR: path.join(profile, "data"),
		LH_AUTH_FILE: path.join(profile, "auth.json"),
	},
});
const lines = createInterface({ input: engine.stdout });
const exited = once(engine, "exit");
try {
	const ready = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Android engine did not become ready")), 30_000);
		lines.on("line", (line) => {
			const port = /^LH_ANDROID_READY (\d+)$/.exec(line)?.[1];
			if (!port) return;
			clearTimeout(timeout);
			resolve(port);
		});
		void exited.then(() => {
			clearTimeout(timeout);
			reject(new Error("Android engine exited before reporting readiness"));
		});
	});
	const origin = `http://127.0.0.1:${await ready}`;
	const attempt = (route, headers) => fetch(origin + route, { headers, signal: AbortSignal.timeout(15_000) });
	const cookie = `lh_android=${token}`;
	for (const route of ["/", "/api/keys", "/api/plugins/flashcards/documents/markdown"]) {
		assert.equal((await attempt(route)).status, 403, `unauthenticated ${route}`);
	}
	assert.equal((await attempt("/", { cookie, origin: "https://example.com" })).status, 403);
	const home = await attempt("/", { cookie });
	assert.equal(home.status, 200);
	assert.match(await home.text(), /lh-android/);
	for (const route of ["/api/chats", "/api/graph", "/api/settings", "/api/plugins"]) {
		const response = await attempt(route, { cookie });
		assert.equal(response.status, 200, route);
		await response.json();
	}
	console.log("Android standalone payload rendered and authenticated its local routes.");
} finally {
	lines.close();
	engine.kill();
	await exited;
	await rm(profile, { recursive: true, force: true });
}
