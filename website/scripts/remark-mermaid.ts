type MarkdownNode = {
  type: string;
  lang?: string | null;
  value?: string;
  children?: MarkdownNode[];
  name?: string;
  attributes?: { type: string; name: string; value: string }[];
};

export function remarkMermaid() {
  function transform(node: MarkdownNode): void {
    node.children = node.children?.map((child) => {
      if (child.type === "code" && child.lang === "mermaid" && child.value) {
        return {
          type: "mdxJsxFlowElement",
          name: "MermaidDiagram",
          attributes: [
            { type: "mdxJsxAttribute", name: "source", value: child.value },
          ],
          children: [],
        };
      }
      if (child.children) transform(child);
      return child;
    });
  }

  return transform;
}
