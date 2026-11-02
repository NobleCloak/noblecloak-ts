/**
 * Finds the places a module's source tells one deployment from another: a word that names a deployment (`hosted`,
 * `mock`, the `x-noblecloak-deployment` marker, a `deployment` member) or a look at the host it talks to (`.host`
 * or `.hostname` read by property, destructuring or `['host']`; a string test on a URL-like value; an equality
 * against a host or URL literal; an `.origin` or `.href` compared for equality). A module is written against the
 * contract, so the same code serves the hosted service and the mock; anything this finds is a branch on where it
 * runs. Comments are not scanned. Test support, not part of the published package.
 *
 * It is a syntactic heuristic, and its blind spots are these: a host held in a variable and compared by a name that
 * is neither URL-like nor a literal (`const known = 'beta.example'; if (h === known)`), a lookup keyed by origin
 * (`table[url.origin]`), and a host passed through a function (`isBeta(url)`). The words rule catches the last when
 * the function is named for the deployment. A string test whose argument is a host literal is flagged whatever the
 * receiver is called, and a `case` clause is checked like an equality.
 */
import ts from 'typescript';

export type ScanRule =
  | 'deployment-word'
  | 'host-property'
  | 'host-string-test'
  | 'host-comparison'
  | 'origin-comparison';

export interface ScanFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: ScanRule;
  readonly text: string;
}

const DEPLOYMENT_WORD = /hosted|mock|x-noblecloak-deployment/i;
const EXACT_DEPLOYMENT = /^deployment$/i;
const HOST_PROPERTIES: ReadonlySet<string> = new Set(['host', 'hostname', 'port']);
const STRING_TESTS: ReadonlySet<string> = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'match',
  'test',
]);
const URL_LIKE = /base_?url|origin|host|endpoint|href|url|\bbase\b/i;
const COMPARED_LIKE = /base_?url|origin|host|endpoint|href/i;
const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
/** A literal that names a host or a URL: `https://x`, `localhost`, or a host name that ends in a common top-level domain. */
const HOST_LITERAL =
  /^(?:[a-z][a-z0-9+.-]*:\/\/|localhost\b|[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|dev|app|ai|cloud|example|test|local|internal)(?::\d+)?$)/i;

function wordIn(text: string): boolean {
  return DEPLOYMENT_WORD.test(text) || EXACT_DEPLOYMENT.test(text);
}

/** What `source` (the text of `file`) does that tells deployments apart. */
export function scanSource(file: string, source: string): ScanFinding[] {
  const found: ScanFinding[] = [];
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const add = (node: ts.Node, rule: ScanRule): void => {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    found.push({ file, line, rule, text: node.getText(tree).slice(0, 80) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (wordIn(node.text)) add(node, 'deployment-word');
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) {
      if (wordIn(node.text)) add(node, 'deployment-word');
    } else if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (wordIn(node.text)) add(node, 'deployment-word');
    }
    if (ts.isPropertyAccessExpression(node) && HOST_PROPERTIES.has(node.name.text)) {
      add(node, 'host-property');
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      HOST_PROPERTIES.has(node.argumentExpression.text)
    ) {
      add(node, 'host-property');
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const named = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(named) || ts.isStringLiteralLike(named)) &&
        HOST_PROPERTIES.has(named.text)
      ) {
        add(node, 'host-property');
      }
    }
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const sides = [node.left, node.right];
      const literal = (n: ts.Expression): n is ts.StringLiteralLike =>
        ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n);
      if (sides.some((n) => literal(n) && HOST_LITERAL.test(n.text))) {
        add(node, 'host-comparison');
      } else if (
        sides.some((n) => literal(n)) &&
        sides.some(
          (n) => !literal(n) && !ts.isTypeOfExpression(n) && COMPARED_LIKE.test(n.getText(tree))
        )
      ) {
        add(node, 'host-comparison');
      }
      if (sides.some((n) => /\.(origin|href)\b/.test(n.getText(tree)))) {
        add(node, 'origin-comparison');
      }
    }
    if (ts.isCaseClause(node)) {
      const subject = ts.isCaseBlock(node.parent) ? node.parent.parent.expression : undefined;
      const wanted = node.expression;
      const literal = ts.isStringLiteralLike(wanted) || ts.isNoSubstitutionTemplateLiteral(wanted);
      if (
        literal &&
        (HOST_LITERAL.test(wanted.text) ||
          (subject !== undefined && COMPARED_LIKE.test(subject.getText(tree))))
      ) {
        add(node, 'host-comparison');
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      STRING_TESTS.has(node.expression.name.text) &&
      (node.arguments.some(
        (a) =>
          (ts.isStringLiteralLike(a) || ts.isNoSubstitutionTemplateLiteral(a)) &&
          HOST_LITERAL.test(a.text)
      ) ||
        (URL_LIKE.test(node.expression.expression.getText(tree)) &&
          node.arguments.some(
            (a) => ts.isStringLiteralLike(a) || ts.isRegularExpressionLiteral(a)
          )) ||
        (ts.isRegularExpressionLiteral(node.expression.expression) &&
          node.arguments.some((a) => URL_LIKE.test(a.getText(tree)))))
    ) {
      add(node, 'host-string-test');
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}
