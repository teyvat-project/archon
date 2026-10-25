import { json, type Route } from '../http.js';

type NodeIn = { name?: unknown; children?: unknown; [key: string]: unknown };

function isNode(value: unknown): value is NodeIn & { name: string; children: unknown[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const node = value as NodeIn;
  return typeof node.name === 'string' && Array.isArray(node.children) && node.children.every(isNode);
}

/** Copies the tree, assigning ids `n1`, `n2`, ... in pre-order and setting `parentId`. */
function assignIds(node: NodeIn & { children: unknown[] }, parentId: string | null, next: () => string): unknown {
  const id = next();
  return {
    ...node,
    id,
    parentId,
    children: node.children.map((child) => assignIds(child as NodeIn & { children: unknown[] }, id, next)),
  };
}

export const nodeRoutes: Route[] = [
  {
    method: 'POST',
    path: /^\/nodes$/,
    handle: (req) => {
      let tree: unknown;
      try {
        tree = JSON.parse(req.body.toString('utf8'));
      } catch {
        tree = undefined;
      }
      if (!isNode(tree)) {
        return json(400, { message: 'Validation failed', fields: [{ name: 'body', reason: 'not a node tree' }] });
      }
      let counter = 0;
      return json(201, assignIds(tree, null, () => `n${++counter}`));
    },
  },
];
