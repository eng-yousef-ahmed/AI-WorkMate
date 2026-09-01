import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/src/renderer", { recursive: true });
await cp("src/renderer/storage-settings.html", "dist/src/renderer/storage-settings.html");
await cp("src/renderer/storage-settings.css", "dist/src/renderer/storage-settings.css");
