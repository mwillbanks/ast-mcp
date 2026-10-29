# Changelog

## [0.6.6](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.6.5...ast-mcp-v0.6.6) (2026-10-29)


### 🚦 Automation

* **50:** select affected PR validation ([94762c8](https://github.com/mwillbanks/ast-mcp/commit/94762c8f338c31d0ba6e7e3c0bd0d6f430e0e4fb))

## [0.6.5](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.6.4...ast-mcp-v0.6.5) (2026-10-29)

### 🐛 Fixes

- **50:** stream snapshots and optimize I/O ([91c21a6](https://github.com/mwillbanks/ast-mcp/commit/91c21a64b8b0e6a2baafd475a296d78a13388e61))

### 🔧 Maintenance

- **deps:** bump the minor-and-patch group across 2 directories with 3 updates ([#49](https://github.com/mwillbanks/ast-mcp/issues/49)) ([d79d64e](https://github.com/mwillbanks/ast-mcp/commit/d79d64ed7dddfff6327560d91a65231b1b34dd19))

## [0.6.4](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.6.3...ast-mcp-v0.6.4) (2026-10-23)

### 🐛 Fixes

- align mutation surfaces and guidance ([df73039](https://github.com/mwillbanks/ast-mcp/commit/df7303919bfeb2a1eb9ae17eae6f44dfc4aa85c5))
- guard metadata and failure diagnostics ([db4a37e](https://github.com/mwillbanks/ast-mcp/commit/db4a37ed4991eeef484c42a0a3a6a94700812fac))
- guard move and write parent directories ([48c4d21](https://github.com/mwillbanks/ast-mcp/commit/48c4d219faaac60d6ae24c49f4bc98d20b4dd8fe))
- preserve receipts across safe retries ([fdd4799](https://github.com/mwillbanks/ast-mcp/commit/fdd4799e42f07d974e4749f4f391c55f05e852d3))
- return honest bounded scan results ([80041ba](https://github.com/mwillbanks/ast-mcp/commit/80041babb28e7a4c8ba4a207984d07e8e79f685c))
- **runtime:** make mutation batches reliable ([#47](https://github.com/mwillbanks/ast-mcp/issues/47)) ([96043c7](https://github.com/mwillbanks/ast-mcp/commit/96043c7c58c092c985041b3d08a074c09519c059))
- validate and scope mutation journals ([12c3b47](https://github.com/mwillbanks/ast-mcp/commit/12c3b47bd57c4791a2c4a4b4a896c5427bbac0c7))

### ⚡ Performance

- reuse batch lock discovery ([2604675](https://github.com/mwillbanks/ast-mcp/commit/26046753d87c25cb35da05eca5ba8537385fbf30))
- scan delete references once per batch ([6e66769](https://github.com/mwillbanks/ast-mcp/commit/6e667697281bb4c1ea7b0247d48c76433877f457))

### 🔧 Maintenance

- sync release metadata ([fa2508a](https://github.com/mwillbanks/ast-mcp/commit/fa2508a1766db9d021c6700fec4c289f5e40df52))

### 🧪 Tests

- cover mutation recovery and parent races ([b0d99ff](https://github.com/mwillbanks/ast-mcp/commit/b0d99ffc1ba707df50d990b8acb1a9c44fadec37))

## [0.6.3](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.6.2...ast-mcp-v0.6.3) (2026-10-23)

### 🐛 Fixes

- eliminate concurrency and shutdown races ([a9b9891](https://github.com/mwillbanks/ast-mcp/commit/a9b9891a44166c68526b64049ffde51d2a1ffb7e))
- **runtime:** prevent MCP stalls and recovery races ([e16f03b](https://github.com/mwillbanks/ast-mcp/commit/e16f03ba017b3cb292d946ba4be6cb36a5ab2183))

### 🚦 Automation

- **release:** resolve the qualified archive locally ([#43](https://github.com/mwillbanks/ast-mcp/issues/43)) ([515147b](https://github.com/mwillbanks/ast-mcp/commit/515147b885fcba8a95f59890355cf4c2c7059028))

## [0.6.2](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.6.1...ast-mcp-v0.6.2) (2026-10-22)

### 🐛 Fixes

- **build:** preserve native package loading ([#42](https://github.com/mwillbanks/ast-mcp/issues/42)) ([6984605](https://github.com/mwillbanks/ast-mcp/commit/69846054afaa699fbf72b3ba39d414e4fa6a3163))
- **ci:** recover partial releases ([dde4d3f](https://github.com/mwillbanks/ast-mcp/commit/dde4d3f5f6030a05909b0b4d3dd6198e7f9a63ef))
- **ci:** restore release publishing ([dd84898](https://github.com/mwillbanks/ast-mcp/commit/dd84898f468d1a3693f67ce5d948f749bf1149bc))
- **config:** detect same-size file rewrites ([60f8af6](https://github.com/mwillbanks/ast-mcp/commit/60f8af66f208dec10f987358b3d126b32adcfc42))

## [0.6.1](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.6.0...ast-mcp-v0.6.1) (2026-10-21)

### 🐛 Fixes

- **ci:** authorize release creation ([fb00dd4](https://github.com/mwillbanks/ast-mcp/commit/fb00dd439eec8142879bda9bb5805fe81f7b3397))
- **ci:** stabilize release validation ([f824b3e](https://github.com/mwillbanks/ast-mcp/commit/f824b3eeaedf855cb226835fa66eff20b2fe8169))
- **installer:** stabilize CI timing checks ([9f2a5e9](https://github.com/mwillbanks/ast-mcp/commit/9f2a5e912d800442ab0873c74c8e9d677e3a0ad2))
- **runtime:** recover formatter failures in CI ([4c512f2](https://github.com/mwillbanks/ast-mcp/commit/4c512f2bd2e0928bbca1f7904bac5107667b25f4))

### 🔧 Maintenance

- **repository:** organize modules and CLI output ([#32](https://github.com/mwillbanks/ast-mcp/issues/32)) ([3007f86](https://github.com/mwillbanks/ast-mcp/commit/3007f867f74839d1f342d11292bfb90d606b3da8))

## [0.6.0](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.5.0...ast-mcp-v0.6.0) (2026-10-21)

### ✨ Features

- Modernize MCP reliability, telemetry, and skills ([#31](https://github.com/mwillbanks/ast-mcp/issues/31)) ([2254f50](https://github.com/mwillbanks/ast-mcp/commit/2254f50dcaf7a5d8c91cb4fbfc59b1461f5bde07))

### 🔧 Maintenance

- **deps:** modernize dependencies and builds ([#28](https://github.com/mwillbanks/ast-mcp/issues/28)) ([2b4f50f](https://github.com/mwillbanks/ast-mcp/commit/2b4f50f9fb52e14d35609a81ae10282a4f225fcb))
- upgrade dependencies and adopt Oxc ([#23](https://github.com/mwillbanks/ast-mcp/issues/23)) ([b5eb4a1](https://github.com/mwillbanks/ast-mcp/commit/b5eb4a13630cef1b43077d2eae0fbca2df6d0f70))

## [0.5.0](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.4.0...ast-mcp-v0.5.0) (2026-09-17)

### Features

- add native intelligence engine ([#18](https://github.com/mwillbanks/ast-mcp/issues/18)) ([9a278dc](https://github.com/mwillbanks/ast-mcp/commit/9a278dc268cabf1e42abdec8bf7c1ca8b9f80364))

## [0.4.0](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.3.0...ast-mcp-v0.4.0) (2026-08-27)

### Features

- **config:** add grouped MCP configuration tools with approval ([548cf51](https://github.com/mwillbanks/ast-mcp/commit/548cf51e531f80336e3233a037b3e1cd5b2fadfb))

### Bug Fixes

- address PR review findings for config, worktrees, and preview ([21b7a24](https://github.com/mwillbanks/ast-mcp/commit/21b7a242a7e022cd48af5e09de3f9f8eeea95a04))
- **config:** use linear-time TOML quoted-string matching ([0a68f76](https://github.com/mwillbanks/ast-mcp/commit/0a68f764950e633b6d2a4ba71e394c81815bc808))
- format checker aliases ([83686e4](https://github.com/mwillbanks/ast-mcp/commit/83686e49220a6428c1ef1a603d7a89f4057ffbda))
- **patch:** skip formatter during file_patch preview ([a4decc7](https://github.com/mwillbanks/ast-mcp/commit/a4decc7c67902e181f06486cbd8aa90e15f124c0))
- preserve canonical ast-bro globs ([c4a3551](https://github.com/mwillbanks/ast-mcp/commit/c4a3551f95e3d7ff26241c4af4482ad973153cd6))
- preserve checker executable mode ([4c841fd](https://github.com/mwillbanks/ast-mcp/commit/4c841fd838a93ce188a7d768abf15ec38c93a2b0))
- preserve cross-platform aliases ([51505eb](https://github.com/mwillbanks/ast-mcp/commit/51505ebef21e15dd55966abeb3d5937f796f72e6))
- preserve literal path errors ([9bd14fa](https://github.com/mwillbanks/ast-mcp/commit/9bd14fa22b1b62361a600ff0aea65090a4e5e3e2))
- reject escaping ast-bro globs ([15adfbe](https://github.com/mwillbanks/ast-mcp/commit/15adfbefe0776846e221c85b2fe2e889817b2203))
- resolve CodeRabbit findings ([d6c1c09](https://github.com/mwillbanks/ast-mcp/commit/d6c1c09a389052b74ccc283f49fecab082748d11))
- use shared executable aliases ([f11399a](https://github.com/mwillbanks/ast-mcp/commit/f11399a527d35a0d03f48a40e054086c3716efa2))
- **workspace:** require gitdir round-trip before trusting worktrees ([e483d77](https://github.com/mwillbanks/ast-mcp/commit/e483d775d411dae8c607a17a4dc5763ecb573fd2))
- **workspace:** treat linked git worktrees as first-class roots ([f65c4e8](https://github.com/mwillbanks/ast-mcp/commit/f65c4e8bfea55873885fc54e314439b98ed3465f))
- worktree roots, unformatted preview, and MCP config writes ([#15](https://github.com/mwillbanks/ast-mcp/issues/15)) ([fcc40bf](https://github.com/mwillbanks/ast-mcp/commit/fcc40bf2288edf5710d768bb3505f87f849b3226))

## [0.3.0](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.2.2...ast-mcp-v0.3.0) (2026-08-01)

### Features

- refresh installer and approval flow ([a76c098](https://github.com/mwillbanks/ast-mcp/commit/a76c098fb72912c49125afce713bf344b2a707f3))

### Bug Fixes

- **deps:** update unbash to 4.0.4 ([473da1f](https://github.com/mwillbanks/ast-mcp/commit/473da1f28bb33fb55bebcb396ca1f003cd991bce))
- handle empty ast-bro output ([da1496b](https://github.com/mwillbanks/ast-mcp/commit/da1496b410909f967c87aa71541cae23d8ddce1b))
- ignore generated template drift ([f2a9856](https://github.com/mwillbanks/ast-mcp/commit/f2a98565a15cd0bbf00eae36e926cb293558d0cc))
- skip unsupported parse checks ([1a52287](https://github.com/mwillbanks/ast-mcp/commit/1a5228702486664e5684241a9068a7766d382970))

## [0.2.2](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.2.1...ast-mcp-v0.2.2) (2026-07-28)

### Bug Fixes

- support host-safe file batches ([fce8ea7](https://github.com/mwillbanks/ast-mcp/commit/fce8ea7ed5d022060801f7c916ede5d67c86c639))

## [0.2.1](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.2.0...ast-mcp-v0.2.1) (2026-07-26)

### Bug Fixes

- use installed CLI wrappers for host integrations ([5cab5fb](https://github.com/mwillbanks/ast-mcp/commit/5cab5fbca96d3c96c79d5adf5b8596b78ad0ff31))

## [0.2.0](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.1.3...ast-mcp-v0.2.0) (2026-07-25)

### Features

- add guarded file rename support ([c39cee2](https://github.com/mwillbanks/ast-mcp/commit/c39cee26634faabe6f6d42e409cb0a27c77f2ae8))
- **config:** ast-mcp.toml configuration ([0260052](https://github.com/mwillbanks/ast-mcp/commit/026005259ff32d2f2a17df7554c622d4dd1b160e))
- http, installer, root fixes ([f84daa1](https://github.com/mwillbanks/ast-mcp/commit/f84daa1c8af0474e1688531d37a04db55aa9d35c))

### Bug Fixes

- github actions cache ([553e9b5](https://github.com/mwillbanks/ast-mcp/commit/553e9b504a48afd1c283bf49e3c4d8d412a98664))
- **hooks:** utilize unbash to aid in hook detection ([17b0f2d](https://github.com/mwillbanks/ast-mcp/commit/17b0f2d3caec2e9cfa67fa9c48f72d91bb85736b))
- stabilize CI coverage validation ([1cddb93](https://github.com/mwillbanks/ast-mcp/commit/1cddb931db03f20d27acd92660967ef955018971))

## [0.1.3](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.1.2...ast-mcp-v0.1.3) (2026-07-23)

### Bug Fixes

- cli surface and package issues ([5dc8504](https://github.com/mwillbanks/ast-mcp/commit/5dc8504a57aa8a7a619eeb611f651405858fac08))
- remove dead-code ([beee009](https://github.com/mwillbanks/ast-mcp/commit/beee009d1b4cc3859e3fde7b43ddb6b01c04d756))

## [0.1.2](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.1.1...ast-mcp-v0.1.2) (2026-07-23)

### Bug Fixes

- harden installer and release docs ([79842ed](https://github.com/mwillbanks/ast-mcp/commit/79842ede374247ec12afb741189be97880445518))

## [0.1.1](https://github.com/mwillbanks/ast-mcp/compare/ast-mcp-v0.1.0...ast-mcp-v0.1.1) (2026-07-22)

### Bug Fixes

- ast-bro/dprint handling, installation guidance and fixes ([59c217e](https://github.com/mwillbanks/ast-mcp/commit/59c217e054c6542296d01ca53669fc2637b67442))
- avoid leaking ast-bro stderr ([7788040](https://github.com/mwillbanks/ast-mcp/commit/7788040a9f627119350cb19bed348cf1528dcf91))
- avoid nested capability transports ([dcdbb12](https://github.com/mwillbanks/ast-mcp/commit/dcdbb12c6c1399ffc8d619bd1845e8101eee0299))
- check command ([4a4e5fb](https://github.com/mwillbanks/ast-mcp/commit/4a4e5fbc551621f82f0b1ea89a958d3b13a8e871))
- cicd ([b5dc819](https://github.com/mwillbanks/ast-mcp/commit/b5dc819b36a367d4cebe8f5a581a9950329edb98))
- gh actions unit test handling / timeouts ([47bd4ce](https://github.com/mwillbanks/ast-mcp/commit/47bd4ce32c90687ee5e4922fd05bbadc5776aa9d))
- install ast-bro before validation ([ffef941](https://github.com/mwillbanks/ast-mcp/commit/ffef9416a87812608dbd2b4a970b9cfcda429ca6))
- invoke native ast-bro binary ([d8b7aea](https://github.com/mwillbanks/ast-mcp/commit/d8b7aea8041cfe711d9193c8a623880e941c5ea3))
- package native tool binaries ([e9f63b8](https://github.com/mwillbanks/ast-mcp/commit/e9f63b86ccb3c9a5395f567257928cbf11fb538d))
- resolve platform dprint binary ([a45e1b8](https://github.com/mwillbanks/ast-mcp/commit/a45e1b8da5546164206c63ae5651470ada551743))
- setup publishConfig ([d5c56ce](https://github.com/mwillbanks/ast-mcp/commit/d5c56cedc0cdac01ff6d2056240559b7adc566b0))
- task routing ([73b0e72](https://github.com/mwillbanks/ast-mcp/commit/73b0e72bf933bce2e6af1da46a886f3b37c6bc29))
- use stable installed CLI ([a84c4a0](https://github.com/mwillbanks/ast-mcp/commit/a84c4a01919f5ead1e0083ad71941f9462239d13))
- version ([3170f19](https://github.com/mwillbanks/ast-mcp/commit/3170f19b90ade42bad6267a17531859918ebab45))
