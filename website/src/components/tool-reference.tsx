import { TOCItem, useItems } from "fumadocs-core/toc";
import { TypeTable } from "fumadocs-ui/components/type-table";

import tools from "@/data/tool-reference.json";
import { parameterRows } from "@/lib/tool-schema";

export function isToolReference(toc: { url: string }[]): boolean {
  return toc.some((item) => tools.some((tool) => item.url === `#${tool.name}`));
}

/** Uses the one AnchorProvider owned by DocsPage. */
export function ToolTOC() {
  const items = useItems();
  return (
    <nav aria-label="Tools on this page" className="tool-toc not-prose">
      <p className="mb-3 font-semibold">Tools on this page</p>
      <ul className="m-0 flex flex-col gap-2 p-0">
        {items.map(({ id, active, original }) => (
          <li key={id} className="list-none">
            <TOCItem
              href={original.url}
              aria-current={active ? "location" : undefined}
              className="block rounded px-2 py-1 font-mono text-sm break-all hover:bg-fd-accent focus-visible:outline-2 data-[active=true]:bg-fd-accent data-[active=true]:text-fd-primary"
            >
              {original.title}
            </TOCItem>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function ToolParameters({ name }: { name: string }) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown documented tool: ${name}`);
  const rows = parameterRows(tool.inputSchema);
  return (
    <div data-tool-parameters={name} className="tool-parameters">
      <p className="text-sm text-fd-muted-foreground">
        Expand a parameter for its full type and constraints. Dotted names
        describe nested fields;
        <code>[]</code> describes array items; <code>.*</code> describes record
        values. Alternatives are separate branches. Required nested fields apply
        when their containing object is supplied.
      </p>
      {Object.keys(rows).length ? (
        <TypeTable id={`parameters-${name}`} type={rows} />
      ) : (
        <p>
          This tool accepts an empty arguments object and has no parameters.
        </p>
      )}
    </div>
  );
}
