import { readFileSync } from "node:fs";

// package.json sits one level above both src/ (development) and dist/ (npm).
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
