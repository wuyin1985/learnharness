import { AsyncLocalStorage } from "node:async_hooks";
import { desktopAPIAuthorized } from "./desktop-access.ts";

const sharedRequest = new AsyncLocalStorage<boolean>();

export function isSharedLearningRequest(headers: Headers): boolean {
	return process.env.LH_DESKTOP_SERVER === "1" && headers.get("x-learnharness-shared") === "1" && desktopAPIAuthorized(headers);
}

export function withSharedLearning<T>(request: Request, run: () => T): T {
	return sharedRequest.run(isSharedLearningRequest(request.headers), run);
}

export function isSharedLearningTurn(): boolean {
	return sharedRequest.getStore() === true;
}
