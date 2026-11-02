import { describe, expect, it } from 'vitest';

import * as entry from '../index.js';
import { loadDocument } from './default.js';

describe('loadDocument', () => {
  it('is exported, and the entry point exports no loadFace', () => {
    expect(entry.loadDocument).toBe(loadDocument);
    expect(Object.keys(entry)).not.toContain('loadFace');
  });
});

describe('the entry point', () => {
  // `openapi.public.yaml` at the package root is not packed (`files` carries `dist/`), so a path to it would not
  // resolve in an installed package; the published copy is `PUBLIC_SPEC`.
  it('does not export the path of the repository copy of the document', () => {
    expect(Object.keys(entry)).not.toContain('PUBLIC_SOURCE');
    expect(Object.keys(entry)).toContain('PUBLIC_SPEC');
  });
});
