/** U+2068 and U+2069: the isolates the component puts around a name, a tool and a source in a sentence. */
export const FSI = String.fromCodePoint(0x2068);
export const PDI = String.fromCodePoint(0x2069);

/** `text` as the component shows a name, a tool or a source: isolated on its own. */
export const iso = (text: string): string => `${FSI}${text}${PDI}`;

/** The tool and source of `tool (source)` in a sentence, each isolated. */
export const toolWithSource = (tool: string, source: string): string =>
  `${iso(tool)} (${iso(source)})`;
