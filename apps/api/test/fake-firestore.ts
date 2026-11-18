/**
 * Tiny in-memory stand-in for the parts of the Firestore Admin API that the
 * Firebase nodes use. Only for tests.
 */
type Data = Record<string, any>;

export function createFakeFirestore() {
  const docs = new Map<string, Data>();
  let auto = 0;

  const snap = (path: string) => {
    const data = docs.get(path);
    return { id: path.split('/').pop()!, exists: data !== undefined, data: () => (data ? structuredClone(data) : undefined), ref: { path } };
  };
  const docRef = (path: string) => ({
    id: path.split('/').pop()!,
    path,
    async get() {
      return snap(path);
    },
    async create(d: Data) {
      if (docs.has(path)) throw Object.assign(new Error('ALREADY_EXISTS: document exists'), { code: 6 });
      docs.set(path, structuredClone(d));
    },
    async set(d: Data, o?: { merge?: boolean }) {
      docs.set(path, o?.merge ? { ...(docs.get(path) ?? {}), ...structuredClone(d) } : structuredClone(d));
    },
    async update(d: Data) {
      if (!docs.has(path)) throw Object.assign(new Error('NOT_FOUND: no document to update'), { code: 5 });
      docs.set(path, { ...docs.get(path), ...structuredClone(d) });
    },
    async delete() {
      docs.delete(path);
    },
  });
  const ops: Record<string, (a: any, b: any) => boolean> = {
    '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
    '>': (a, b) => a > b, '>=': (a, b) => a >= b, 'array-contains': (a, b) => Array.isArray(a) && a.includes(b), in: (a, b) => b.includes(a),
  };
  const query = (col: string, filters: [string, string, any][] = [], order?: [string, string], lim = 1000): any => ({
    where: (f: string, op: string, v: any) => query(col, [...filters, [f, op, v]], order, lim),
    orderBy: (f: string, d: string) => query(col, filters, [f, d], lim),
    limit: (n: number) => query(col, filters, order, n),
    doc: (id?: string) => docRef(`${col}/${id ?? `auto${++auto}`}`),
    async get() {
      let list = [...docs.keys()].filter((p) => p.startsWith(`${col}/`) && p.split('/').length === col.split('/').length + 1);
      list = list.filter((p) => filters.every(([f, op, v]) => ops[op](docs.get(p)![f], v)));
      if (order) list.sort((a, b) => (docs.get(a)![order[0]] > docs.get(b)![order[0]] ? 1 : -1) * (order[1] === 'desc' ? -1 : 1));
      return { docs: list.slice(0, lim).map(snap) };
    },
  });
  const db = {
    collection: (p: string) => query(p),
    doc: (p: string) => docRef(p),
    async listCollections() {
      return [];
    },
    settings() {},
  };
  return { db: db as any, docs };
}
