import { handleChatRequest, withSharedLearning } from "@/src/server";

export async function POST(req: Request) {
	return withSharedLearning(req, () => handleChatRequest(req));
}
