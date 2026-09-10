import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdown-parse';

/**
 * What an agent wrote, read as the markdown it is.
 *
 * Agents write headings, lists, fenced code and tables, and every screen used to show that as
 * preformatted text — a page of `##` and backticks you read past rather than read, and the
 * more careful the answer the worse it looked.
 *
 * The rule that does not bend: **nothing here becomes HTML.** The parser produces a tree, this
 * turns the tree into React elements, and `dangerouslySetInnerHTML` appears nowhere. A
 * `<script>` in an agent's answer is a paragraph that says `<script>`, which is what a reader
 * needs to see anyway.
 *
 * `pre.log` keeps its place: command output, diffs and run logs are not markdown and must keep
 * their exact shape. This is for prose.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);

  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block)}</Fragment>
      ))}
    </div>
  );
}

function renderBlock(block: Block): ReactNode {
  switch (block.kind) {
    case 'heading': {
      // Scaled down by the stylesheet rather than by picking a smaller tag: a heading inside a
      // panel must not compete with the panel's own, and the document still reads correctly to
      // anything that follows the levels.
      const Tag = `h${Math.min(block.level, 6)}` as 'h1';
      return <Tag>{renderInline(block.children)}</Tag>;
    }
    case 'paragraph':
      return <p>{renderInline(block.children)}</p>;
    case 'code':
      return (
        <pre className="md-code">
          <code>{block.text}</code>
        </pre>
      );
    case 'rule':
      return <hr />;
    case 'quote':
      return (
        <blockquote>
          {block.children.map((child, index) => (
            <Fragment key={index}>{renderBlock(child)}</Fragment>
          ))}
        </blockquote>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          {item.map((child, inner) => (
            <Fragment key={inner}>{renderBlock(child)}</Fragment>
          ))}
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table':
      return (
        // Its own scroller: a wide table must not push the page wider than the window.
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>;
      case 'link':
        // `noreferrer` as well as `noopener`: an agent's answer can name any address, and the
        // page it opens does not need to be told where the reader came from.
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}
