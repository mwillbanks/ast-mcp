import type { ResolveConfigOptions, ResolvedConfig } from "../config";
import { currentConfig } from "../config";
import { configurationResolutionOptions } from "../config/identity.ts";
import {
  type MutationIndexObservation,
  observeMutationIndex,
} from "../intelligence/mutation/service.ts";
import type { WorkspaceHandle } from "../intelligence/workspace/index.ts";
import type { IntelligenceToolService } from "../tools/intelligence.ts";

export interface GraphIntelligence {
  run<T>(
    config: ResolvedConfig,
    resolution: ResolveConfigOptions | undefined,
    workspace: WorkspaceHandle,
    operation: (service: IntelligenceToolService) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export type SharedMutationIndexObserver = (
  workspace: WorkspaceHandle,
  config: ResolvedConfig,
) => Promise<MutationIndexObservation>;

export type GraphEntry = {
  createGraphIntelligence(
    observe: SharedMutationIndexObserver,
  ): Promise<GraphIntelligence>;
};

interface ProjectRuntime {
  graph: Bun.ModuleGraph;
  service: Promise<GraphIntelligence>;
  active: number;
  idle?: ReturnType<typeof setTimeout>;
}

export class ProjectRuntimes {
  readonly #entries = new Map<string, ProjectRuntime>();
  readonly #retiring = new Set<Promise<void>>();
  #stopping = false;

  constructor(
    private readonly entry: string,
    private readonly maxProjects = 32,
    private readonly idleMs = 30_000,
  ) {}

  #create(key: string): ProjectRuntime {
    if (this.#entries.size + this.#retiring.size >= this.maxProjects)
      throw Object.assign(
        new Error("Shared project runtime capacity reached"),
        {
          code: "project_runtime_busy",
          retryable: true,
        },
      );
    const graph = new Bun.ModuleGraph({
      onError() {
        process.stderr.write("ast-mcp: project runtime reported an error\n");
      },
    });
    const service = graph
      .import<GraphEntry>(this.entry)
      .then((entry) =>
        graph.run(() => entry.createGraphIntelligence(observeMutationIndex)),
      );
    const runtime = { graph, service, active: 0 };
    this.#entries.set(key, runtime);
    // Retire a failed launch after its last caller leaves the graph.
    void service.catch(() => undefined);
    return runtime;
  }

  #retire(key: string, runtime: ProjectRuntime): Promise<void> {
    if (this.#entries.get(key) !== runtime) return Promise.resolve();
    this.#entries.delete(key);
    clearTimeout(runtime.idle);
    const retirement = runtime.service
      .then((service) => runtime.graph.run(() => service.close()))
      .catch(() => {
        process.stderr.write("ast-mcp: project runtime cleanup failed\n");
      })
      .finally(() => {
        runtime.graph.dispose();
        this.#retiring.delete(retirement);
      });
    this.#retiring.add(retirement);
    return retirement;
  }

  #drained(): boolean {
    return [...this.#entries.values()].every((runtime) => runtime.active === 0);
  }

  #onDrain?: () => void;

  async #use<T>(
    workspace: WorkspaceHandle,
    operation: (service: IntelligenceToolService) => Promise<T>,
  ): Promise<T> {
    if (this.#stopping) throw new Error("Shared project runtimes are closing");
    const key = workspace.checkoutRoot;
    const runtime = this.#entries.get(key) ?? this.#create(key);
    clearTimeout(runtime.idle);
    runtime.active++;
    let ready = false;
    try {
      const [service, config] = await Promise.all([
        runtime.service,
        currentConfig(),
      ]);
      ready = true;
      return await runtime.graph.run(() =>
        service.run(
          config,
          configurationResolutionOptions(config),
          workspace,
          operation,
        ),
      );
    } finally {
      runtime.active--;
      if (!runtime.active && this.#entries.get(key) === runtime) {
        if (this.#stopping) {
          if (this.#drained()) this.#onDrain?.();
        } else if (!ready) {
          void this.#retire(key, runtime);
        } else {
          runtime.idle = setTimeout(() => {
            void this.#retire(key, runtime);
          }, this.idleMs);
          runtime.idle.unref?.();
        }
      }
    }
  }

  readonly intelligence: IntelligenceToolService = {
    generate: (input, workspace, dependencies, signal) =>
      this.#use(workspace, (service) =>
        service.generate(input, workspace, dependencies, signal),
      ),
    graphDiff: (input, base, target) =>
      this.#use(base, (service) => service.graphDiff(input, base, target)),
    graphExplain: (input, workspace, signal) =>
      this.#use(workspace, (service) =>
        service.graphExplain(input, workspace, signal),
      ),
    graphPath: (input, workspace, signal) =>
      this.#use(workspace, (service) =>
        service.graphPath(input, workspace, signal),
      ),
    graphQuery: (input, workspace, signal) =>
      this.#use(workspace, (service) =>
        service.graphQuery(input, workspace, signal),
      ),
    index: (input, workspace, signal) =>
      this.#use(workspace, (service) =>
        service.index(input, workspace, signal),
      ),
    indexStatus: (workspace, input, signal) =>
      this.#use(workspace, (service) =>
        service.indexStatus(workspace, input, signal),
      ),
    retrieve: (input, workspace, signal) =>
      this.#use(workspace, (service) =>
        service.retrieve(input, workspace, signal),
      ),
  };

  #closing?: Promise<void>;

  close(): Promise<void> {
    this.#stopping = true;
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (!this.#drained())
      await new Promise<void>((resolve) => {
        this.#onDrain = resolve;
      });
    await Promise.all([
      ...[...this.#entries].map(([key, runtime]) => this.#retire(key, runtime)),
      ...this.#retiring,
    ]);
  }
}
