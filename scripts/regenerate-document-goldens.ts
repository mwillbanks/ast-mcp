import { join } from "node:path";

import {
  analyzeDocument,
  DOCUMENT_GOLDEN_PROVENANCE,
  type DocumentFacts,
  type DocumentFormat,
  documentCapabilities,
} from "../src/intelligence/documents/index.ts";
import { sha256 } from "../src/intelligence/parser/index.ts";

type GoldenRecord = {
  facts: DocumentFacts;
  fixture: string;
  fixtureSha256: string;
  format: DocumentFormat;
};

type DocumentGoldens = {
  capabilities: typeof documentCapabilities;
  provenance: typeof DOCUMENT_GOLDEN_PROVENANCE;
  records: GoldenRecord[];
  unsupported: GoldenRecord;
};

const root = join(
  import.meta.dir,
  "..",
  "tests",
  "fixtures",
  "intelligence",
  "documents",
);
const goldenPath = join(root, "document-goldens.json");
const current = (await Bun.file(goldenPath).json()) as DocumentGoldens;

async function regenerate(record: GoldenRecord): Promise<GoldenRecord> {
  const source = await Bun.file(join(root, record.fixture)).text();
  return {
    facts: await analyzeDocument({ format: record.format, source }),
    fixture: record.fixture,
    fixtureSha256: sha256(source),
    format: record.format,
  };
}

const next: DocumentGoldens = {
  capabilities: documentCapabilities,
  provenance: DOCUMENT_GOLDEN_PROVENANCE,
  records: await Promise.all(current.records.map(regenerate)),
  unsupported: await regenerate(current.unsupported),
};
await Bun.write(goldenPath, `${JSON.stringify(next, null, 2)}\n`);
