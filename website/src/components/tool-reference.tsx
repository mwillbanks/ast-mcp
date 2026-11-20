import { TOCItem, useItems } from "fumadocs-core/toc";
import { TypeTable } from "fumadocs-ui/components/type-table";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import tools from "@/data/tool-reference.json";
import { parameterRows } from "@/lib/tool-schema";

export function isToolReference(toc: { url: string }[]): boolean {
  return toc.some((item) => tools.some((tool) => item.url === `#${tool.name}`));
}

/** Uses the one AnchorProvider owned by DocsPage. */
export function ToolTOC() {
  const items = useItems();
  const [fragment, setFragment] = useState<string | null>(null);
  const navigation = useRef<{
    id: string;
    settledScrollTop: number | null;
  } | null>(null);
  const selectFragment = useCallback((id: string | null) => {
    const target = id ? document.getElementById(id) : null;
    const bounds = target?.getBoundingClientRect();
    const scroller = document.scrollingElement ?? document.documentElement;
    const inset = target
      ? (Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0) +
        (Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0)
      : 0;
    // Initial fragment scrolling can finish before hydration installs scrollend.
    const settled = Boolean(
      bounds &&
      (Math.abs(bounds.top - inset) <= 1 ||
        (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <=
          1 &&
          bounds.top < innerHeight &&
          bounds.bottom > 0)),
    );
    const settledScrollTop = settled ? scroller.scrollTop : null;
    if (navigation.current?.id !== id) {
      navigation.current = id ? { id, settledScrollTop } : null;
    } else if (navigation.current && settled) {
      navigation.current.settledScrollTop = settledScrollTop;
    }
    setFragment(id);
  }, []);
  const activateFragment = (
    event: ReactMouseEvent<HTMLAnchorElement>,
    id: string,
  ) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    selectFragment(id);
  };

  useEffect(() => {
    const followFragment = () => {
      const hash = window.location.hash.slice(1);
      let id = hash;
      try {
        id = decodeURIComponent(hash);
      } catch {
        // A malformed escape still permits a literal heading ID.
      }
      selectFragment(id || null);
    };
    const onScroll = () => {
      const current = navigation.current;
      if (!current || current.settledScrollTop === null) return;
      const scroller = document.scrollingElement ?? document.documentElement;
      // History restoration can deliver scroll after its destination is captured.
      if (scroller.scrollTop !== current.settledScrollTop) selectFragment(null);
    };
    const onScrollEnd = () => {
      const current = navigation.current;
      if (!current) return;
      const target = document.getElementById(current.id);
      const bounds = target?.getBoundingClientRect();
      if (!bounds || bounds.bottom <= 0 || bounds.top >= window.innerHeight) {
        selectFragment(null);
      } else {
        const scroller = document.scrollingElement ?? document.documentElement;
        current.settledScrollTop = scroller.scrollTop;
      }
    };
    followFragment();
    window.addEventListener("hashchange", followFragment);
    window.addEventListener("popstate", followFragment);
    document.addEventListener("scroll", onScroll);
    document.addEventListener("scrollend", onScrollEnd);
    return () => {
      window.removeEventListener("hashchange", followFragment);
      window.removeEventListener("popstate", followFragment);
      document.removeEventListener("scroll", onScroll);
      document.removeEventListener("scrollend", onScrollEnd);
    };
  }, [selectFragment]);

  const selected = items.some((item) => item.id === fragment) ? fragment : null;
  const groups: { item: (typeof items)[number]; children: typeof items }[] = [];
  for (const observed of items) {
    const item = selected
      ? { ...observed, active: observed.id === selected }
      : observed;
    if (item.original.depth === 2) groups.push({ item, children: [] });
    else groups.at(-1)?.children.push(item);
  }
  return (
    <nav aria-label="Tools on this page" className="tool-toc not-prose">
      <p className="mb-3 font-semibold">Tools on this page</p>
      <ul className="m-0 flex flex-col gap-2 p-0">
        {groups.map(({ item: { id, active, original }, children }) => (
          <li key={id} className="list-none">
            <TOCItem
              href={original.url}
              onClick={(event) => activateFragment(event, id)}
              data-active={String(active)}
              aria-current={active ? "location" : undefined}
              className="block rounded px-2 py-1 font-mono text-sm break-all hover:bg-fd-accent focus-visible:outline-2 data-[active=true]:bg-fd-accent data-[active=true]:text-fd-primary"
            >
              {original.title}
            </TOCItem>
            {children.length > 0 && (
              <ul
                aria-label="Tool subsections"
                className="mt-1 ml-3 border-l pl-2"
              >
                {children.map((child) => (
                  <li key={child.id} className="list-none">
                    <TOCItem
                      href={child.original.url}
                      onClick={(event) => activateFragment(event, child.id)}
                      data-active={String(child.active)}
                      aria-current={child.active ? "location" : undefined}
                      className="block rounded px-2 py-1 text-xs hover:bg-fd-accent focus-visible:outline-2 data-[active=true]:text-fd-primary"
                    >
                      {child.original.title}
                    </TOCItem>
                  </li>
                ))}
              </ul>
            )}
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
        describe nested fields; <code>$</code> describes restrictions on the
        complete arguments object;
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
