import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_DIR } from "./config.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
export const trustManifestSchema = JSON.parse(readFileSync(path.join(AGENT_DIR, "schemas", "trust-manifest-0.1.json"), "utf8"));
export const validateTrustManifest = ajv.compile(trustManifestSchema);
