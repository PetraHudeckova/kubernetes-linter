import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, hoverTooltip, keymap, type DecorationSet } from '@codemirror/view';
import { yaml } from '@codemirror/lang-yaml';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { indentWithTab } from '@codemirror/commands';
import { schema } from './lint/index.js';
import { pathAtOffset } from './lint/parse.js';
import type { LocatedFinding } from './lint/types.js';
import { applyFix } from './lint/fix.js';
import { changedLineNumbers } from './ui/diff.js';

/**
 * Mark the lines a fix just rewrote. Applying a fix replaces the whole
 * document, so without this the editor gives no sign that anything happened —
 * especially when the problem count lands on the same number by coincidence.
 */
export const markChangedLines = StateEffect.define<number[]>();

const changedLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(markChangedLines)) continue;
      const lines = effect.value;
      if (lines.length === 0) return Decoration.none;

      const doc = transaction.state.doc;
      return Decoration.set(
        lines
          .filter((line) => line >= 1 && line <= doc.lines)
          .map((line) => changedLineMark.range(doc.line(line).from)),
        true,
      );
    }
    // Any other edit means the highlight no longer describes the document.
    return transaction.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const changedLineMark = Decoration.line({ class: 'cm-changed-line' });

export interface EditorHooks {
  /** Called on every document change with the current text. */
  onChange(text: string): void;
  /** Findings for the current text, supplied by the host. */
  current(): LocatedFinding[];
}

export function createEditor(parent: HTMLElement, initialText: string, hooks: EditorHooks): EditorView {
  const diagnostics = linter(
    (view) => hooks.current().map((finding) => toDiagnostic(view, finding)),
    { delay: 150 },
  );

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initialText,
      extensions: [
        basicSetup,
        yaml(),
        lintGutter(),
        diagnostics,
        changedLines,
        fieldTooltip,
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        // Without this the browser spellchecker underlines the whole manifest,
        // which is indistinguishable from the lint markers.
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          'aria-label': 'Kubernetes manifest',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) hooks.onChange(update.state.doc.toString());
        }),
        theme,
      ] satisfies Extension[],
    }),
  });

  return view;
}

function toDiagnostic(view: EditorView, finding: LocatedFinding): Diagnostic {
  const length = view.state.doc.length;
  const diagnostic: Diagnostic = {
    from: Math.min(finding.from, length),
    to: Math.min(Math.max(finding.to, finding.from + 1), length),
    severity: finding.severity,
    source: finding.ruleId,
    message: finding.explanation ? `${finding.message}\n\n${finding.explanation}` : finding.message,
  };

  const fix = finding.fix;
  if (fix) {
    diagnostic.actions = [
      {
        name: fix.title,
        apply(target) {
          const text = target.state.doc.toString();
          const updated = applyFix(text, fix, finding.docIndex);
          if (updated === text) return;
          target.dispatch({
            changes: { from: 0, to: target.state.doc.length, insert: updated },
            effects: markChangedLines.of(changedLineNumbers(text, updated)),
          });
        },
      },
    ];
  }
  return diagnostic;
}

/**
 * Hovering a key explains it using the field's own description from the
 * Kubernetes OpenAPI spec, which ships with the schema bundle.
 */
const fieldTooltip = hoverTooltip((view, pos) => {
  const located = pathAtOffset(view.state.doc.toString(), pos);
  if (!located) return null;

  const described = schema.describe(located.path);
  if (!described) return null;

  return {
    pos: located.from,
    end: located.to,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-field-tooltip';

      const heading = document.createElement('div');
      heading.className = 'cm-field-tooltip-head';
      heading.textContent = `${described.title}: ${described.type}`;
      dom.append(heading);

      if (described.required) {
        const badge = document.createElement('span');
        badge.className = 'cm-field-tooltip-required';
        badge.textContent = 'required';
        heading.append(' ', badge);
      }

      if (described.description) {
        const body = document.createElement('p');
        body.textContent = described.description;
        dom.append(body);
      }
      return { dom };
    },
  };
});

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '.cm-content': { paddingBlock: '0.75rem' },
  '.cm-changed-line': {
    backgroundColor: 'var(--change-highlight)',
    boxShadow: 'inset 3px 0 0 var(--ok)',
  },
  '.cm-field-tooltip': {
    maxWidth: '32rem',
    padding: '0.6rem 0.75rem',
    fontFamily: 'var(--font-sans)',
    fontSize: '12.5px',
    lineHeight: '1.5',
  },
  '.cm-field-tooltip-head': {
    fontFamily: 'var(--font-mono)',
    fontWeight: '600',
    marginBottom: '0.35rem',
  },
  '.cm-field-tooltip-required': {
    fontFamily: 'var(--font-sans)',
    fontWeight: '500',
    fontSize: '11px',
    padding: '0.05rem 0.35rem',
    borderRadius: '999px',
    background: 'var(--danger-soft)',
    color: 'var(--danger)',
  },
  '.cm-field-tooltip p': { margin: 0, opacity: '0.85' },
});
