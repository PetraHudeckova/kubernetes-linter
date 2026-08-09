import { describe, expect, it } from 'vitest';
import { changedLineNumbers, diffLines } from '../src/ui/diff.js';
import { applyFix, applySafeFixes } from '../src/lint/index.js';
import { expectRule } from './helpers.js';

describe('changedLineNumbers', () => {
  it('is empty when nothing changed', () => {
    expect(changedLineNumbers('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
  });

  it('reports a rewritten line, 1-based, in the new text', () => {
    expect(changedLineNumbers('a\nb\nc\n', 'a\nB\nc\n')).toEqual([2]);
  });

  it('reports inserted lines', () => {
    expect(changedLineNumbers('a\nc\n', 'a\nb1\nb2\nc\n')).toEqual([2, 3]);
  });

  it('reports nothing for a pure deletion', () => {
    expect(changedLineNumbers('a\nb\nc\n', 'a\nc\n')).toEqual([]);
  });

  it('stays within the bounds of the new text', () => {
    const after = 'a\nB\nC\nd\n';
    for (const line of changedLineNumbers('a\nb\nc\nd\n', after)) {
      expect(line).toBeGreaterThanOrEqual(1);
      expect(line).toBeLessThanOrEqual(after.split('\n').length);
    }
  });

  it('marks exactly the lines a real fix rewrote', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: web
      image: nginx
      imagePullPolicy: always
`;
    const after = applyFix(before, expectRule(before, 'enum/invalid-value').fix!);
    const lines = changedLineNumbers(before, after);

    expect(lines).toEqual([9]);
    expect(after.split('\n')[8]).toContain('imagePullPolicy: Always');
  });

  it('marks every line that a bulk fix rewrote', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  contaienrs:
    - name: web
      image: nginx
      imagePullPolicy: always
`;
    const { text, applied } = applySafeFixes(before);
    expect(applied).toBe(2);

    const lines = changedLineNumbers(before, text);
    expect(lines).toEqual([6, 9]);

    const rewritten = text.split('\n');
    expect(rewritten[5]).toContain('containers:');
    expect(rewritten[8]).toContain('imagePullPolicy: Always');
  });
});

describe('diffLines', () => {
  it('trims to the neighbourhood of the change', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 15', 'LINE 15');
    const lines = diffLines(before, after);

    expect(lines.length).toBeLessThan(10);
    expect(lines.some((line) => line.kind === 'added' && line.text === 'LINE 15')).toBe(true);
    expect(lines.some((line) => line.kind === 'removed' && line.text === 'line 15')).toBe(true);
    expect(lines.some((line) => line.text === '…')).toBe(true);
  });

  it('returns nothing when the texts are identical', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([]);
  });
});
