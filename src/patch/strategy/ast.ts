import type { PatchStrategyAdapter } from "../strategy";
import { preparePatchIsolated } from "./worker-client.ts";
export { inlineAstStrategy } from "./inline.ts";

export const astStrategy: PatchStrategyAdapter = {
  name: "ast",
  prepare: (context) => preparePatchIsolated("ast", context),
};
