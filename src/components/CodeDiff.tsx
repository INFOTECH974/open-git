import { useEffect, useRef } from "react";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";

import type { FileContents } from "@/bindings";

export type DiffMode = "unified" | "split";

interface Props {
  path: string;
  contents: FileContents;
  mode: DiffMode;
  /** Wrap long lines instead of scrolling horizontally. */
  wrap: boolean;
}

const COLLAPSE = { margin: 3, minSize: 6 };

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

const baseTheme = EditorView.theme({
  "&": { fontSize: "12px", height: "100%" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.5" },
  ".cm-gutters": { borderRight: "none" },
});

/** Shared, read-only editor setup; `language` and `theme` are swapped at runtime. */
function extensions(language: Compartment, theme: Compartment, wrap: boolean): Extension[] {
  return [
    baseTheme,
    lineNumbers(),
    highlightSpecialChars(),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    wrap ? EditorView.lineWrapping : [],
    language.of([]),
    theme.of(isDark() ? oneDark : []),
  ];
}

/**
 * Both sides of a file rendered by CodeMirror: syntax highlighting, changed
 * words marked inside changed lines, unchanged stretches folded.
 */
export function CodeDiff({ path, contents, mode, wrap }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const language = new Compartment();
    const theme = new Compartment();
    const shared = extensions(language, theme, wrap);
    const old = contents.old ?? "";
    const current = contents.new ?? "";

    let views: EditorView[];
    let merge: MergeView | undefined;
    if (mode === "split") {
      merge = new MergeView({
        a: { doc: old, extensions: shared },
        b: { doc: current, extensions: shared },
        parent,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: COLLAPSE,
      });
      views = [merge.a, merge.b];
    } else {
      views = [
        new EditorView({
          doc: current,
          extensions: [
            shared,
            unifiedMergeView({
              original: old,
              highlightChanges: true,
              gutter: true,
              mergeControls: false,
              collapseUnchanged: COLLAPSE,
            }),
          ],
          parent,
        }),
      ];
    }

    // Syntax highlighting arrives once the language package is loaded.
    let cancelled = false;
    const description = LanguageDescription.matchFilename(languages, path);
    if (description) {
      description.load().then(
        (support) => {
          if (cancelled) return;
          for (const view of views) view.dispatch({ effects: language.reconfigure(support) });
        },
        () => {
          // No highlighting for this file; the diff is still readable.
        },
      );
    }

    // Follow the application theme while the diff is open.
    const observer = new MutationObserver(() => {
      const dark = isDark();
      for (const view of views) view.dispatch({ effects: theme.reconfigure(dark ? oneDark : []) });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      cancelled = true;
      observer.disconnect();
      if (merge) merge.destroy();
      else views.forEach((view) => view.destroy());
    };
  }, [path, contents, mode, wrap]);

  return <div ref={host} className="code-diff h-full" />;
}
