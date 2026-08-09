import { EditorView } from 'codemirror';
import { createEditor, markChangedLines } from './editor.js';
import { lint, applySafeFixes, K8S_VERSION, type LintResult } from './lint/index.js';
import { renderFindings } from './ui/findings-panel.js';
import { changedLineNumbers } from './ui/diff.js';
import { EXAMPLES } from './ui/examples.js';
import type { LocatedFinding, Severity } from './lint/types.js';
import './styles.css';

const SEVERITIES: Severity[] = ['error', 'warning', 'info'];
const LABELS: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'note' };

const dom = {
  editor: required('editor'),
  findings: required('findings'),
  summary: required('summary'),
  filters: required('filters'),
  examples: required('examples'),
  fixAll: required('fix-all') as HTMLButtonElement,
  copy: required('copy') as HTMLButtonElement,
  share: required('share') as HTMLButtonElement,
  version: required('version'),
  status: required('status'),
};

dom.version.textContent = `Kubernetes v${K8S_VERSION}`;

let result: LintResult = { findings: [], documentCount: 0, errors: 0, warnings: 0, infos: 0 };
const hidden = new Set<Severity>();

const view = createEditor(dom.editor, initialDocument(), {
  onChange: (text) => refresh(text),
  current: () => result.findings,
});

refresh(view.state.doc.toString());

function refresh(text: string): void {
  result = lint(text);
  // A status line describes one edit; the next change to the document retires
  // it. Programmatic replacements set a fresh one straight after dispatching.
  clearStatus();
  renderSummary();
  renderVisibleFindings();
  updateFixAllButton();
}

function safeFixCount(): number {
  return result.findings.filter((finding) => finding.fix?.safe).length;
}

function updateFixAllButton(): void {
  const available = safeFixCount();
  dom.fixAll.disabled = available === 0;
  dom.fixAll.title =
    available === 0
      ? result.findings.length === 0
        ? 'Nothing to fix.'
        : 'Every remaining problem needs a decision that only you can make.'
      : `Apply ${available} unambiguous ${available === 1 ? 'fix' : 'fixes'}, re-checking after each one.`;
}

/**
 * Replace the document and show what moved: the rewritten lines are marked in
 * the editor and the outcome is spelled out, since the problem count alone can
 * land on the same number and look like nothing happened.
 */
function replaceDocument(text: string, note?: string): void {
  const before = view.state.doc.toString();
  if (text === before) return;

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    effects: markChangedLines.of(changedLineNumbers(before, text)),
  });
  if (note) setStatus(note);
  view.focus();
}

function setStatus(message: string): void {
  dom.status.textContent = message;
  dom.status.hidden = false;
}

function clearStatus(): void {
  dom.status.hidden = true;
  dom.status.textContent = '';
}

function visibleFindings(): LocatedFinding[] {
  return result.findings.filter((finding) => !hidden.has(finding.severity));
}

function renderVisibleFindings(): void {
  renderFindings(dom.findings, visibleFindings(), {
    reveal(finding) {
      view.dispatch({
        selection: { anchor: finding.from, head: finding.to },
        effects: EditorView.scrollIntoView(finding.from, { y: 'center' }),
        scrollIntoView: true,
      });
      view.focus();
    },
    replace(text) {
      replaceDocument(text, 'Applied 1 fix. The rewritten lines are highlighted.');
    },
    currentText: () => view.state.doc.toString(),
  });
}

function renderSummary(): void {
  const counts: Record<Severity, number> = {
    error: result.errors,
    warning: result.warnings,
    info: result.infos,
  };

  const documents = result.documentCount === 1 ? 'this document' : `${result.documentCount} documents`;
  dom.summary.textContent =
    result.documentCount === 0
      ? 'Nothing to lint yet.'
      : result.findings.length === 0
        ? 'No problems found.'
        : `${count(result.findings.length, 'problem')} in ${documents}`;

  dom.filters.replaceChildren();
  for (const severity of SEVERITIES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter filter-${severity}`;
    button.setAttribute('aria-pressed', String(!hidden.has(severity)));
    button.disabled = counts[severity] === 0;
    button.textContent = count(counts[severity], LABELS[severity]);
    button.addEventListener('click', () => {
      if (hidden.has(severity)) hidden.delete(severity);
      else hidden.add(severity);
      renderSummary();
      renderVisibleFindings();
    });
    dom.filters.append(button);
  }
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/* Toolbar */

for (const example of EXAMPLES) {
  const option = document.createElement('option');
  option.value = example.id;
  option.textContent = example.label;
  option.title = example.blurb;
  dom.examples.append(option);
}

dom.examples.addEventListener('change', (event) => {
  const id = (event.target as HTMLSelectElement).value;
  const example = EXAMPLES.find((entry) => entry.id === id);
  if (!example) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: example.yaml } });
  (event.target as HTMLSelectElement).selectedIndex = 0;
  view.focus();
});

dom.fixAll.addEventListener('click', () => {
  const before = view.state.doc.toString();
  const { text, applied } = applySafeFixes(before);

  if (applied === 0) {
    setStatus('Nothing was changed: every remaining problem needs a decision that only you can make.');
    return;
  }

  const remaining = lint(text);
  replaceDocument(text, describeOutcome(applied, remaining));
});

/**
 * Say what changed and what is left. Fixing one problem often uncovers others
 * that were hidden beneath it, so the count can go up — which is progress, and
 * needs saying out loud.
 */
function describeOutcome(applied: number, remaining: LintResult): string {
  const fixes = `Applied ${applied} ${applied === 1 ? 'fix' : 'fixes'}`;

  if (remaining.findings.length === 0) return `${fixes}. No problems left.`;

  const left = `${remaining.findings.length} ${remaining.findings.length === 1 ? 'problem' : 'problems'} left`;
  const stillSafe = remaining.findings.filter((finding) => finding.fix?.safe).length;
  const why = stillSafe > 0 ? '.' : ', each needing a decision that only you can make.';
  return `${fixes}. The rewritten lines are highlighted. ${left}${why}`;
}

dom.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(view.state.doc.toString());
  flash(dom.copy, 'Copied');
});

dom.share.addEventListener('click', async () => {
  const url = new URL(window.location.href);
  url.hash = `yaml=${encodeURIComponent(view.state.doc.toString())}`;
  window.history.replaceState(null, '', url.toString());
  await navigator.clipboard.writeText(url.toString());
  flash(dom.share, 'Link copied');
});

/**
 * Momentary confirmation on a button. It restores the label but deliberately
 * does not restore `disabled` — whether the button should be usable depends on
 * the document, which may well have changed in the meantime.
 */
function flash(button: HTMLButtonElement, message: string): void {
  const original = button.textContent;
  const wasDisabled = button.disabled;
  button.textContent = message;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = wasDisabled;
  }, 1200);
}

/**
 * The document travels in the URL fragment, which browsers never send to a
 * server — the manifest stays on the machine that typed it.
 */
function initialDocument(): string {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const shared = hash.get('yaml');
  if (shared) return shared;
  return EXAMPLES[0]?.yaml ?? '';
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element;
}
