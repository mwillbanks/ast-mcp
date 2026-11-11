const prebuilds = {
  "darwin-arm64": "macOS-ARM64",
  "darwin-x64": "macOS-X64",
  "linux-arm64": "Linux-ARM64",
  "linux-x64": "Linux-X64",
  "win32-x64": "Windows-X64",
} as const;

type Target = keyof typeof prebuilds;
export type PackLanguage = "python" | "go" | "sql";
export type PackVersions = Partial<Record<PackLanguage, string>>;

export const packVersions = {
  python: "0.0.6",
  go: "0.0.6",
  sql: "0.0.8",
} as const;
export const packLanguages = ["python", "go", "sql"] as const;

const manifest = {
  python: {
    abi: 15,
    expandoChar: "µ",
    integrity:
      "eF/bEBspmrxdVuPNihvZDyyJx5qtIpGEMz9l1nNQmrji7NZcUiRNC8WwzYyQCBdy1mj8HZ0Tn4I2q3gp/6Bkiw==",
    digests: {
      "darwin-arm64":
        "8dfebc0b31573358675b369fc31ac9a5b157bd1638b4ba5ae12dcb615c4e5d44",
      "darwin-x64":
        "b392204ec25979026fef4b5720f983da1a097e9ee904b582d9eaf843c16e66d2",
      "linux-arm64":
        "649202886ae35b74c0bd592d3e7894863ada06887112f0b57a295032a553ce4d",
      "linux-x64":
        "44fb5deaf239c37fe4fd281b848aff98bcd28051e8c7f332e5336c73861b86f0",
      "win32-x64":
        "3d9ea3003fec3ba346ab60c4aaee7f5654cb597ff943df82ce07c9685a08cd59",
    },
  },
  go: {
    abi: 15,
    expandoChar: "µ",
    integrity:
      "PZap9Rp6t+YKbLjRnFRF5aGBX3/HV9s5Rp7ZPsCM+o3tlTZDo1IqDYnFu+Oeh5Razs2U8K8ccPSJ+GBxalVhWg==",
    digests: {
      "darwin-arm64":
        "3398f5b5d2b716cf8cb1fe514123fcf3b4ea4660d675391a8321e62bfe7ba007",
      "darwin-x64":
        "efe4ac285b31cf455cdcee1c043b10e2723b975bfbdd3a29f0f967ff25009b3c",
      "linux-arm64":
        "0239688e434b07bd0abda1c049ae0f23723f0fb282caaaefcd78b655d5f29d66",
      "linux-x64":
        "597d6c0839e3894536e2736be93a0c8e95ab155a831ad0bce7dc8685e3a27ed4",
      "win32-x64":
        "df75fd01450bcec411d68aae951f0e2f327b7eeee224bf5bdcb9bec90683f18d",
    },
  },
  sql: {
    abi: 14,
    expandoChar: "_",
    integrity:
      "akMaGvhtjgQ2t1YLl4uqYfCfrYQmUS4WnqYugDHBeGOrLzSkM+aUFQ0R0fhRjY3CGsiTb8eXUtnhnxyy44l8Yw==",
    digests: {
      "darwin-arm64":
        "87e38ac29bcfc18d9a0c9f94a7b988a9e8b563070757a7707ec0761b233a0e49",
      "darwin-x64":
        "09df7a6279384475f5cb7851cd8543f2bc5e651babee8ee7d0dff97b7d59f1ba",
      "linux-arm64":
        "2c01b7f5e86b75be9698f7d014f5034188ec0fe3d363df77af5fc9e56e99d1c2",
      "linux-x64":
        "dd46159f4678433126c594c4cd3fd164658de3c0ea75d7ed3867febd7ef095c1",
      "win32-x64":
        "2b94ca0eca70eabb378de3b8f1a8aeab4ff43ecdcc4d20987620adb4753efc6f",
    },
  },
} satisfies Record<
  PackLanguage,
  {
    abi: number;
    expandoChar: string;
    integrity: string;
    digests: Record<Target, string>;
  }
>;

export const setupPackage = {
  packageName: "@ast-grep/setup-lang",
  url: "https://registry.npmjs.org/@ast-grep/setup-lang/-/setup-lang-0.0.6.tgz",
  integrity:
    "aSYZNF5nGQMxnwiA3Lcc8zi0AtpGlug47ADgqCgP/2n7p922FbnW7vo1rbW4kKjW72B/3mDdN7uvYidv8JnPnw==",
};

export function isPackLanguage(language: string): language is PackLanguage {
  return Object.hasOwn(packVersions, language);
}

export function nativePackDescriptor(
  language: PackLanguage,
  platform = process.platform,
  arch = process.arch,
) {
  const target = `${platform}-${arch}`;
  if (!Object.hasOwn(prebuilds, target)) return null;
  const prebuild = prebuilds[target as Target];
  const entry = manifest[language];
  const version = packVersions[language];
  const sha256 = entry.digests[target as Target];
  return {
    abi: entry.abi,
    expandoChar: entry.expandoChar,
    filename: `${sha256}.so`,
    integrity: entry.integrity,
    language,
    languageSymbol: `tree_sitter_${language}`,
    packageName: `@ast-grep/lang-${language}`,
    packagePath: `prebuilds/prebuild-${prebuild}/parser.so`,
    sha256,
    url: `https://registry.npmjs.org/@ast-grep/lang-${language}/-/lang-${language}-${version}.tgz`,
    version,
  };
}

export type PackDescriptor = NonNullable<
  ReturnType<typeof nativePackDescriptor>
>;
