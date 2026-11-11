import { useEffect, useId, useState } from "react";

const themes = {
  light: {
    background: "#f8faff",
    primaryColor: "#e5edff",
    primaryTextColor: "#162547",
    primaryBorderColor: "#567ac4",
    secondaryColor: "#eee9ff",
    tertiaryColor: "#edf5ff",
    lineColor: "#4c6090",
    textColor: "#213358",
    edgeLabelBackground: "#f8faff",
    series: "#8499bb, #235bd8",
  },
  dark: {
    background: "#10192d",
    primaryColor: "#253c66",
    primaryTextColor: "#f0f5ff",
    primaryBorderColor: "#7ea6f4",
    secondaryColor: "#342959",
    tertiaryColor: "#192c49",
    lineColor: "#a7bcdf",
    textColor: "#e2ebfd",
    edgeLabelBackground: "#10192d",
    series: "#93a9d0, #6b9dff",
  },
};

let renderQueue: Promise<unknown> = Promise.resolve();

function renderDiagram(id: string, source: string, dark: boolean) {
  const render = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    const { series, ...palette } = dark ? themes.dark : themes.light;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        ...palette,
        darkMode: dark,
        fontFamily: "Inter, system-ui, sans-serif",
        xyChart: {
          backgroundColor: palette.background,
          titleColor: palette.textColor,
          xAxisLabelColor: palette.textColor,
          yAxisLabelColor: palette.textColor,
          xAxisTitleColor: palette.textColor,
          yAxisTitleColor: palette.textColor,
          xAxisLineColor: palette.lineColor,
          yAxisLineColor: palette.lineColor,
          xAxisTickColor: palette.lineColor,
          yAxisTickColor: palette.lineColor,
          plotColorPalette: series,
        },
      },
      flowchart: { curve: "basis", htmlLabels: false, nodeSpacing: 36 },
      xyChart: { width: 720, height: 380 },
    });
    return (await mermaid.render(id, source)).svg;
  });
  renderQueue = render.catch(() => undefined);
  return render;
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = "ast-mermaid-" + useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    let generation = 0;
    let dark: boolean | undefined;
    function render() {
      const nextDark = root.classList.contains("dark");
      if (nextDark === dark) return;
      dark = nextDark;
      const current = ++generation;
      void renderDiagram(id, source, dark).then(
        (result) => {
          if (current !== generation) return;
          setSvg(result);
          setFailed(false);
        },
        () => {
          if (current !== generation) return;
          setSvg(undefined);
          setFailed(true);
        },
      );
    }
    const observer = new MutationObserver(render);
    observer.observe(root, { attributeFilter: ["class"] });
    render();
    return () => {
      ++generation;
      observer.disconnect();
    };
  }, [id, source]);

  return (
    <figure className="docs-mermaid not-prose" aria-label="Mermaid diagram">
      {svg ? (
        <div
          className="docs-mermaid-graphic"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <>
          {failed && <p>Diagram preview unavailable.</p>}
          <pre>
            <code>{source}</code>
          </pre>
        </>
      )}
    </figure>
  );
}
