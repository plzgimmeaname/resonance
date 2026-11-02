// import this first in every test file: it points the database at a fresh temp folder
// (node --test runs each file in its own process, so files don't share a database)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "resonance-test-"));
