import { withResolvedConfig } from "../config";
import { bindConfigurationResolution } from "../config/identity.ts";
import { stopMutationRefreshes } from "../intelligence/mutation/experimental-deferred-refresh.ts";
import { withMutationIndexObserver } from "../intelligence/mutation/service.ts";
import { withWorkspaceContext } from "../intelligence/workspace/context.ts";
import { createIntelligenceToolService } from "../tools/intelligence.ts";
import type {
  GraphIntelligence,
  SharedMutationIndexObserver,
} from "./project-runtimes.ts";

export async function createGraphIntelligence(
  observe: SharedMutationIndexObserver,
): Promise<GraphIntelligence> {
  const service = createIntelligenceToolService();
  return {
    run: (config, resolution, workspace, operation) => {
      if (resolution) bindConfigurationResolution(config, resolution);
      return withResolvedConfig(config, () =>
        withWorkspaceContext(workspace, () =>
          withMutationIndexObserver(
            (selected) => observe(selected, config),
            () => operation(service),
          ),
        ),
      );
    },
    close: async () => {
      try {
        await stopMutationRefreshes();
      } finally {
        await service.close?.();
      }
    },
  };
}
