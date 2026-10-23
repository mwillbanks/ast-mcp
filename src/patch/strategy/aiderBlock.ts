import type { PatchStrategyAdapter } from "../strategy";
import { preparePatchIsolated } from "./worker-client.ts";
export { inlineAiderBlockStrategy } from "./inline.ts";

export const aiderBlockStrategy: PatchStrategyAdapter = {
  name: "aider_block",
  prepare: (context) => preparePatchIsolated("aider_block", context),
};
