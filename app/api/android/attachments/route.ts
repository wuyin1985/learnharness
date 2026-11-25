import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data";
import { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BYTES } from "@/lib/notes-import-limits";

export const runtime = "nodejs";

export async function POST(request: Request) {
	const root = process.env.LH_ANDROID_ATTACHMENTS;
	if (!root) return new Response(null, { status: 404 });
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES);
	} catch (error) {
		const oversized = error instanceof FormBodyLimitError;
		return Response.json({ error: oversized ? "Select files totaling 25 MB or less." : "Could not read the selected files." },
			{ status: oversized ? 413 : 400 });
	}
	const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
	if (!files.length || files.length > 32) {
		return Response.json({ error: "Select between 1 and 32 files." }, { status: 400 });
	}
	if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
		return Response.json({ error: "Select files totaling 25 MB or less." }, { status: 413 });
	}
	let batch: string | undefined;
	try {
		await mkdir(root, { recursive: true, mode: 0o700 });
		batch = await mkdtemp(path.join(root, "files-"));
		const paths = [];
		for (const [index, file] of files.entries()) {
			const name = Array.from(file.name.replace(/[\x00-\x1f\x7f/\\'"]/g, "_")).slice(-60).join("");
			const destination = path.join(batch, `${index + 1}-${name || "attachment"}`);
			await writeFile(destination, new Uint8Array(await file.arrayBuffer()), { mode: 0o600, flag: "wx" });
			paths.push(destination);
		}
		return Response.json({ paths });
	} catch {
		if (batch) await rm(batch, { recursive: true, force: true }).catch(() => {});
		return Response.json({ error: "Could not save the selected files." }, { status: 500 });
	}
}
