import type { LocatedFinding, Severity } from '../lint/types.js';
import { applyFix } from '../lint/fix.js';
import { diffLines } from './diff.js';

export interface PanelCallbacks {
  /** Move the editor selection to this finding. */
  reveal(finding: LocatedFinding): void;
  /** Replace the whole document with the fixed text. */
  replace(text: string): void;
  currentText(): string;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Note',
};

export function renderFindings(
  container: HTMLElement,
  findings: LocatedFinding[],
  callbacks: PanelCallbacks,
): void {
  container.replaceChildren();

  if (findings.length === 0) {
    container.append(emptyState());
    return;
  }

  for (const finding of findings) {
    container.append(card(finding, callbacks));
  }
}

function emptyState(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty';
  wrapper.innerHTML = `
    <div class="empty-mark" aria-hidden="true">✓</div>
    <h2>No problems found</h2>
    <p>This manifest matches the Pod schema and passes every validation rule the linter knows about.</p>
  `;
  return wrapper;
}

function card(finding: LocatedFinding, callbacks: PanelCallbacks): HTMLElement {
  const element = document.createElement('article');
  element.className = `finding finding-${finding.severity}`;

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'finding-head';
  header.addEventListener('click', () => {
    callbacks.reveal(finding);
    element.classList.toggle('is-open');
  });

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = SEVERITY_LABEL[finding.severity];

  const message = document.createElement('span');
  message.className = 'finding-message';
  message.textContent = finding.message;

  const location = document.createElement('span');
  location.className = 'finding-location';
  location.textContent = `${finding.line}:${finding.column}`;

  header.append(badge, message, location);
  element.append(header);

  const body = document.createElement('div');
  body.className = 'finding-body';

  if (finding.path.length > 0) {
    const path = document.createElement('code');
    path.className = 'finding-path';
    path.textContent = formatPath(finding.path);
    body.append(path);
  }

  if (finding.explanation) {
    for (const paragraph of finding.explanation.split('\n\n')) {
      const p = document.createElement('p');
      p.textContent = paragraph;
      body.append(p);
    }
  }

  const links = document.createElement('div');
  links.className = 'finding-links';

  const rule = document.createElement('code');
  rule.className = 'finding-rule';
  rule.textContent = finding.ruleId;
  links.append(rule);

  if (finding.docsUrl) {
    const link = document.createElement('a');
    link.href = finding.docsUrl;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = 'Kubernetes docs ↗';
    links.append(link);
  }
  body.append(links);

  if (finding.fix) {
    body.append(fixSection(finding, callbacks));
  }

  element.append(body);
  return element;
}

function fixSection(finding: LocatedFinding, callbacks: PanelCallbacks): HTMLElement {
  const fix = finding.fix!;
  const section = document.createElement('div');
  section.className = 'fix';

  const heading = document.createElement('div');
  heading.className = 'fix-head';

  const title = document.createElement('span');
  title.className = 'fix-title';
  title.textContent = fix.title;

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'button button-apply';
  apply.textContent = 'Apply';
  apply.addEventListener('click', (event) => {
    event.stopPropagation();
    const before = callbacks.currentText();
    const after = applyFix(before, fix, finding.docIndex);
    if (after !== before) callbacks.replace(after);
  });

  heading.append(title, apply);
  if (!fix.safe) {
    const note = document.createElement('span');
    note.className = 'fix-note';
    note.textContent = 'check this one';
    note.title =
      'This fix guesses at what you meant, so it is not included in "Apply all safe fixes".';
    heading.insertBefore(note, apply);
  }
  section.append(heading);

  const before = callbacks.currentText();
  const after = applyFix(before, fix, finding.docIndex);
  const lines = diffLines(before, after);

  if (lines.length > 0) {
    const preview = document.createElement('pre');
    preview.className = 'diff';
    for (const line of lines) {
      const row = document.createElement('span');
      row.className = `diff-line diff-${line.kind}`;
      const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
      row.textContent = `${marker} ${line.text}`;
      preview.append(row);
    }
    section.append(preview);
  }

  return section;
}

function formatPath(path: (string | number)[]): string {
  return path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
    .join('')
    .replace(/^\./, '');
}
