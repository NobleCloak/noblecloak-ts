// @vitest-environment jsdom
import { axe } from './testing/axe.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('the jsdom lane', () => {
  it('renders a .tsx tree in a DOM and checks it with axe', async () => {
    const { container } = render(<button type="button">Approve</button>);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('axe reports a violation, so the check can fail', async () => {
    const { container } = render(<img src="x.png" />);
    const result = await axe(container);
    expect(result.violations.map((violation) => violation.id)).toContain('image-alt');
  });
});
