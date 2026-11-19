import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findReadmeProblems, runReadmeCheck } from './check-readmes.js';

const PACKAGE_README = [
  '# @noblecloak/fixture',
  '',
  'What it is.',
  '',
  '## Install',
  '',
  '```sh',
  'npm install @noblecloak/fixture',
  '```',
  '',
  '## Quickstart',
  '',
  'Call it.',
  '',
  '## License',
  '',
  'Apache-2.0.',
  '',
].join('\n');

const EXAMPLE_README = [
  '# Fixture example',
  '',
  '## What this shows',
  '',
  'A thing.',
  '',
  '## Run it against the mock',
  '',
  'Start it.',
  '',
  '## Troubleshooting',
  '',
  'Restart it.',
  '',
].join('\n');

let root: string;

function write(relativePath: string, content: unknown): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** Replaces the fixture package's README with the conforming one after `edit`. */
function writePackageReadme(edit: (readme: string) => string): void {
  write('packages/a/README.md', edit(PACKAGE_README));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'readme-fixture-'));
  write('package.json', {
    name: 'fixture-root',
    private: true,
    workspaces: ['packages/*', 'examples/*'],
  });
  write('packages/a/package.json', { name: '@noblecloak/fixture', version: '1.0.0' });
  write('packages/a/README.md', PACKAGE_README);
  write('examples/app/package.json', { name: 'fixture-app', version: '0.0.0', private: true });
  write('examples/app/README.md', EXAMPLE_README);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findReadmeProblems', () => {
  it('passes a publishable package and an example whose READMEs have every section', () => {
    expect(findReadmeProblems(root)).toEqual([]);
  });

  it('names the package whose README is missing', () => {
    rmSync(join(root, 'packages/a/README.md'));
    expect(findReadmeProblems(root)).toEqual([
      { file: 'packages/a/README.md', subject: '@noblecloak/fixture', kind: 'missing-readme' },
    ]);
  });

  it.each([
    ['Install', '## Install'],
    ['Quickstart, Usage or Use', '## Quickstart'],
    ['License', '## License'],
  ])('names the missing %s section', (section, heading) => {
    writePackageReadme((readme) => readme.replace(heading, '## Something else'));
    expect(findReadmeProblems(root)).toEqual([
      {
        file: 'packages/a/README.md',
        subject: '@noblecloak/fixture',
        kind: 'missing-section',
        section,
      },
    ]);
  });

  it.each(['Usage', 'Use', 'quickstart', 'USAGE'])(
    'accepts "## %s" as the usage section',
    (text) => {
      writePackageReadme((readme) => readme.replace('## Quickstart', `## ${text}`));
      expect(findReadmeProblems(root)).toEqual([]);
    }
  );

  it('does not accept a heading that only starts with a section name', () => {
    writePackageReadme((readme) => readme.replace('## Install', '## Install notes'));
    expect(findReadmeProblems(root).map((p) => [p.kind, p.section])).toEqual([
      ['missing-section', 'Install'],
    ]);
  });

  it('does not accept a section at a level other than ##', () => {
    writePackageReadme((readme) => readme.replace('## License', '### License'));
    expect(findReadmeProblems(root).map((p) => [p.kind, p.section])).toEqual([
      ['missing-section', 'License'],
    ]);
  });

  it('flags a section with nothing under it', () => {
    writePackageReadme((readme) => readme.replace('Apache-2.0.\n', ''));
    expect(findReadmeProblems(root)).toEqual([
      {
        file: 'packages/a/README.md',
        subject: '@noblecloak/fixture',
        kind: 'empty-section',
        section: 'License',
      },
    ]);
  });

  it('counts a subsection as the content of its section', () => {
    writePackageReadme((readme) =>
      readme.replace('Call it.', '### With a token\n\nCall it with a token.')
    );
    expect(findReadmeProblems(root)).toEqual([]);
  });

  it('flags a first heading that is not the package name', () => {
    writePackageReadme((readme) => readme.replace('# @noblecloak/fixture', '# Fixture'));
    expect(findReadmeProblems(root)).toEqual([
      { file: 'packages/a/README.md', subject: '@noblecloak/fixture', kind: 'wrong-title' },
    ]);
  });

  it('flags a README whose first heading is a section, not the title', () => {
    writePackageReadme((readme) => readme.replace('# @noblecloak/fixture\n', 'Intro.\n'));
    expect(findReadmeProblems(root).map((p) => p.kind)).toEqual(['wrong-title']);
  });

  it('reports a placeholder README: the title alone has no sections', () => {
    write('packages/a/README.md', '# @noblecloak/fixture\n\nComing soon.\n');
    expect(findReadmeProblems(root).map((p) => [p.kind, p.section])).toEqual([
      ['missing-section', 'Install'],
      ['missing-section', 'Quickstart, Usage or Use'],
      ['missing-section', 'License'],
    ]);
  });

  it('ignores a heading inside a fenced code block', () => {
    write(
      'packages/a/README.md',
      [
        '```sh',
        '# a shell comment, not the title',
        '```',
        '',
        '# @noblecloak/fixture',
        '',
        '~~~md',
        '## Install',
        '## Quickstart',
        '## License',
        '~~~',
        '',
      ].join('\n')
    );
    expect(findReadmeProblems(root).map((p) => [p.kind, p.section])).toEqual([
      ['missing-section', 'Install'],
      ['missing-section', 'Quickstart, Usage or Use'],
      ['missing-section', 'License'],
    ]);
  });

  it('does not check a private package outside examples/', () => {
    write('packages/b/package.json', {
      name: '@noblecloak/later',
      version: '0.0.0',
      private: true,
    });
    write('packages/b/README.md', '# @noblecloak/later\n\nPlaceholder.\n');
    expect(findReadmeProblems(root)).toEqual([]);
  });

  it('names the example whose README is missing', () => {
    rmSync(join(root, 'examples/app/README.md'));
    expect(findReadmeProblems(root)).toEqual([
      { file: 'examples/app/README.md', subject: 'fixture-app', kind: 'missing-readme' },
    ]);
  });

  it.each([
    ['What this shows', '## What this shows'],
    ['Run it', '## Run it against the mock'],
    ['Troubleshooting', '## Troubleshooting'],
  ])('names the example section %s when it is missing', (section, heading) => {
    write('examples/app/README.md', EXAMPLE_README.replace(heading, '## Something else'));
    expect(findReadmeProblems(root)).toEqual([
      { file: 'examples/app/README.md', subject: 'fixture-app', kind: 'missing-section', section },
    ]);
  });

  it('does not ask an example for the package sections or a title that matches its name', () => {
    expect(findReadmeProblems(root).filter((p) => p.file.startsWith('examples/'))).toEqual([]);
  });
});

describe('runReadmeCheck', () => {
  it('prints one line and exits 0 on a clean workspace, naming what it did not check', () => {
    write('packages/b/package.json', {
      name: '@noblecloak/later',
      version: '0.0.0',
      private: true,
    });
    const lines: string[] = [];
    expect(runReadmeCheck(root, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([
      'README check: OK (1 publishable package, 1 example; not checked, private: @noblecloak/later)',
    ]);
  });

  it('leaves the private clause out when every package was checked', () => {
    const lines: string[] = [];
    expect(runReadmeCheck(root, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual(['README check: OK (1 publishable package, 1 example)']);
  });

  it('prints one line per problem with the file, the package and the reason, and exits 1', () => {
    writePackageReadme((readme) =>
      readme.replace('# @noblecloak/fixture', '# Fixture').replace('## License', '## Licence')
    );
    rmSync(join(root, 'examples/app/README.md'));
    const lines: string[] = [];
    expect(runReadmeCheck(root, (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual([
      'examples/app/README.md: fixture-app — has no README.md',
      'packages/a/README.md: @noblecloak/fixture — the first heading must be "# @noblecloak/fixture"',
      'packages/a/README.md: @noblecloak/fixture — has no "## License" section',
      'README check: 3 problem(s)',
    ]);
  });

  it('says which headings satisfy the usage section, and that an empty section is empty', () => {
    writePackageReadme((readme) =>
      readme.replace('## Quickstart', '## Embed it').replace('Apache-2.0.\n', '')
    );
    const lines: string[] = [];
    expect(runReadmeCheck(root, (line) => lines.push(line))).toBe(1);
    expect(lines.slice(0, 2)).toEqual([
      'packages/a/README.md: @noblecloak/fixture — has no "## Quickstart", "## Usage" or "## Use" section',
      'packages/a/README.md: @noblecloak/fixture — the "## License" section is empty',
    ]);
  });
});
