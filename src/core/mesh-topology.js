/**
 * 拓扑分析与修复：目标是把网格修成流形（每条边最多 2 个面片、顶点周围只有一片扇形），
 * 这样才能用于有限元、布尔运算、参数化等后续几何处理。
 */
import { buildEdgeFaces } from './mesh.js';
import { fixOrientation } from './mesh-clean.js';

/** 顶点 → 关联面片 */
function buildVertexFaces(indices, vertexCount) {
  const vertexFaces = Array.from({ length: vertexCount }, () => []);
  for (let f = 0; f < indices.length / 3; f++) {
    vertexFaces[indices[f * 3]].push(f);
    vertexFaces[indices[f * 3 + 1]].push(f);
    vertexFaces[indices[f * 3 + 2]].push(f);
  }
  return vertexFaces;
}

/** 顶点周围的面片按"绕该点的边"分组，返回分组数（>1 即蝴蝶结非流形点） */
function countFans(v, faceList, indices, edgeFaces) {
  if (faceList.length <= 1) return faceList.length;

  const seen = new Set();
  let fans = 0;

  for (const seed of faceList) {
    if (seen.has(seed)) continue;
    fans++;
    const stack = [seed];
    seen.add(seed);

    while (stack.length) {
      const f = stack.pop();
      for (let k = 0; k < 3; k++) {
        const a = indices[f * 3 + k];
        const b = indices[f * 3 + ((k + 1) % 3)];
        if (a !== v && b !== v) continue;
        const rec = edgeFaces.get(a < b ? `${a}_${b}` : `${b}_${a}`);
        if (!rec || rec.faces.length !== 2) continue;
        for (const nf of rec.faces) {
          if (nf === f || seen.has(nf)) continue;
          seen.add(nf);
          stack.push(nf);
        }
      }
    }
  }
  return fans;
}

/**
 * 统计拓扑信息。
 * @returns {{faces:number, vertices:number, edges:number, nonManifoldEdges:number,
 *   boundaryEdges:number, nonManifoldVertices:number, components:number, euler:number,
 *   isManifold:boolean, isClosed:boolean}}
 */
export function analyzeTopology({ positions, indices }) {
  const V = positions.length / 3;
  const F = indices.length / 3;
  const edges = buildEdgeFaces(indices);
  const vertexFaces = buildVertexFaces(indices, V);

  let nonManifoldEdges = 0;
  let boundaryEdges = 0;
  for (const rec of edges.values()) {
    if (rec.faces.length > 2) nonManifoldEdges++;
    else if (rec.faces.length === 1) boundaryEdges++;
  }

  let nonManifoldVertices = 0;
  for (let v = 0; v < V; v++) {
    const list = vertexFaces[v];
    if (list.length === 0) continue;
    if (countFans(v, list, indices, edges) > 1) nonManifoldVertices++;
  }

  // 面片连通分量
  const seen = new Uint8Array(F);
  let components = 0;
  for (let seed = 0; seed < F; seed++) {
    if (seen[seed]) continue;
    components++;
    seen[seed] = 1;
    const stack = [seed];
    while (stack.length) {
      const f = stack.pop();
      for (let k = 0; k < 3; k++) {
        const a = indices[f * 3 + k];
        const b = indices[f * 3 + ((k + 1) % 3)];
        const rec = edges.get(a < b ? `${a}_${b}` : `${b}_${a}`);
        if (!rec) continue;
        for (const nf of rec.faces) {
          if (!seen[nf]) {
            seen[nf] = 1;
            stack.push(nf);
          }
        }
      }
    }
  }

  return {
    faces: F,
    vertices: V,
    edges: edges.size,
    nonManifoldEdges,
    boundaryEdges,
    nonManifoldVertices,
    components,
    euler: V - edges.size + F,
    isManifold: nonManifoldEdges === 0 && nonManifoldVertices === 0,
    isClosed: boundaryEdges === 0,
  };
}

/**
 * 拓扑修复：去重复面/退化面 → 拆分非流形边 → 拆分非流形顶点 → 清孤立顶点 → 统一朝向。
 * 拆分会在原位置产生裂缝（保持几何形状、牺牲封闭性），如需封闭还需配合补洞。
 */
export function repairTopology({ positions, indices }, { fixNormals = true } = {}) {
  const pos = Array.from(positions);
  const idx = [];
  const stats = {
    facesIn: indices.length / 3,
    duplicateFaces: 0,
    degenerateFaces: 0,
    splitEdges: 0,
    splitVertices: 0,
    removedVertices: 0,
    flipped: 0,
  };

  // ---- 1. 去掉退化面（顶点重复）与重复面（顶点集合相同） ----
  const seenFaces = new Set();
  for (let f = 0; f < indices.length / 3; f++) {
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];
    if (a === b || b === c || c === a) {
      stats.degenerateFaces++;
      continue;
    }
    const key = [a, b, c].sort((x, y) => x - y).join('_');
    if (seenFaces.has(key)) {
      stats.duplicateFaces++;
      continue;
    }
    seenFaces.add(key);
    idx.push(a, b, c);
  }

  const rebuildEdgeFaces = () => {
    const map = new Map();
    for (let f = 0; f < idx.length / 3; f++) {
      for (let k = 0; k < 3; k++) {
        const x = idx[f * 3 + k];
        const y = idx[f * 3 + ((k + 1) % 3)];
        const key = x < y ? `${x}_${y}` : `${y}_${x}`;
        const rec = map.get(key);
        if (rec) rec.faces.push(f);
        else map.set(key, { a: Math.min(x, y), b: Math.max(x, y), faces: [f] });
      }
    }
    return map;
  };

  const duplicateVertex = (v) => {
    pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    return pos.length / 3 - 1;
  };

  // ---- 2. 拆分非流形边：超过 2 个面片的部分各自获得一对新顶点 ----
  for (const rec of rebuildEdgeFaces().values()) {
    if (rec.faces.length <= 2) continue;
    for (let i = 2; i < rec.faces.length; i++) {
      const f = rec.faces[i];
      const na = duplicateVertex(rec.a);
      const nb = duplicateVertex(rec.b);
      for (let k = 0; k < 3; k++) {
        if (idx[f * 3 + k] === rec.a) idx[f * 3 + k] = na;
        else if (idx[f * 3 + k] === rec.b) idx[f * 3 + k] = nb;
      }
      stats.splitEdges++;
    }
  }

  // ---- 3. 拆分非流形顶点（蝴蝶结）：把多片扇形拆成独立顶点 ----
  // 拆分本身不会制造新的非流形结构，因此先一次性找出所有待拆顶点再批量处理，
  // 避免「每拆一个顶点就重建整张拓扑表」导致的 O(顶点数 × 面数) 卡顿。
  let edges = rebuildEdgeFaces();

  for (let pass = 0; pass < 4; pass++) {
    const vertexFaces = buildVertexFaces(new Uint32Array(idx), pos.length / 3);
    const pending = [];

    for (let v = 0; v < vertexFaces.length; v++) {
      const list = vertexFaces[v];
      if (list.length <= 1) continue;

      // 按共享边把面片分成若干扇形
      const visited = new Set();
      const groups = [];
      for (const seed of list) {
        if (visited.has(seed)) continue;
        const group = [];
        visited.add(seed);
        const stack = [seed];
        while (stack.length) {
          const f = stack.pop();
          group.push(f);
          for (let k = 0; k < 3; k++) {
            const a = idx[f * 3 + k];
            const b = idx[f * 3 + ((k + 1) % 3)];
            if (a !== v && b !== v) continue;
            const rec = edges.get(a < b ? `${a}_${b}` : `${b}_${a}`);
            if (!rec || rec.faces.length !== 2) continue;
            for (const nf of rec.faces) {
              if (nf === f || visited.has(nf)) continue;
              // 只处理仍以 v 为顶点的面片
              const stillV = idx[nf * 3] === v || idx[nf * 3 + 1] === v || idx[nf * 3 + 2] === v;
              if (!stillV) continue;
              visited.add(nf);
              stack.push(nf);
            }
          }
        }
        groups.push(group);
      }

      if (groups.length > 1) pending.push({ v, groups });
    }

    if (pending.length === 0) break;

    for (const { v, groups } of pending) {
      for (let g = 1; g < groups.length; g++) {
        const nv = duplicateVertex(v);
        for (const f of groups[g]) {
          for (let k = 0; k < 3; k++) {
            if (idx[f * 3 + k] === v) idx[f * 3 + k] = nv;
          }
        }
        stats.splitVertices++;
      }
    }

    // 索引已变化，进入下一轮前刷新拓扑结构
    edges = rebuildEdgeFaces();
  }

  // ---- 4. 删除孤立顶点并压实索引 ----
  const used = new Uint8Array(pos.length / 3);
  for (const i of idx) used[i] = 1;

  const remap = new Int32Array(pos.length / 3).fill(-1);
  const outPos = [];
  for (let i = 0; i < used.length; i++) {
    if (!used[i]) {
      stats.removedVertices++;
      continue;
    }
    remap[i] = outPos.length / 3;
    outPos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  }

  let outIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) outIdx[i] = remap[idx[i]];

  // ---- 5. 统一法向 ----
  if (fixNormals && outIdx.length >= 3) {
    const res = fixOrientation(new Float32Array(outPos), outIdx);
    outIdx = res.indices;
    stats.flipped = res.flipped;
  }

  return {
    mesh: { positions: new Float32Array(outPos), indices: outIdx },
    stats,
  };
}

