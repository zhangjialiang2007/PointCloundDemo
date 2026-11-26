/**
 * 网格简化：二次误差度量（QEM）驱动的边折叠。
 * 每条边计算折叠代价（到相邻面片平面的距离平方和），优先折叠代价最小的边，
 * 折叠前做链接条件与翻转检查，保证结果仍是流形且形状不塌陷。
 */
import { computeFaceNormals } from './mesh.js';

/** 四元式：Q = [aa, ab, ac, ad, bb, bc, bd, cc, cd, dd] */
function quadricCost(q, x, y, z) {
  return (
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x +
    q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y +
    q[7] * z * z + 2 * q[8] * z + q[9]
  );
}

/** 求 AᵀQ 的最小值点（3x3 线性方程），退化时返回 null */
function optimalPoint(q, ux, uy, uz, vx, vy, vz) {
  const a = q[0], b = q[1], c = q[2], d = q[4], e = q[5], f = q[7];
  const det =
    a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c);
  if (Math.abs(det) < 1e-12) return null;

  const x = -q[3], y = -q[6], z = -q[8];
  const inv = 1 / det;
  const px = ((d * f - e * e) * x - (b * f - c * e) * y + (b * e - c * d) * z) * inv;
  const py = (-(b * f - c * e) * x + (a * f - c * c) * y - (a * e - b * c) * z) * inv;
  const pz = ((b * e - c * d) * x - (a * e - b * c) * y + (a * d - b * b) * z) * inv;

  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
  // 解过远时退化为中点，避免数值爆炸
  const span = Math.hypot(ux - vx, uy - vy, uz - vz) * 4;
  if (Math.hypot(px - (ux + vx) / 2, py - (uy + vy) / 2, pz - (uz + vz) / 2) > span) return null;
  return [px, py, pz];
}

/** 二叉最小堆（惰性删除：出堆时校验顶点版本号） */
class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * QEM 边折叠简化。
 * @param {{positions: Float32Array, indices: Uint32Array}} mesh
 * @param {{targetRatio?: number, targetFaces?: number}} options
 * @returns {{positions: Float32Array, indices: Uint32Array, facesIn: number, facesOut: number}}
 */
export function simplifyMesh({ positions, indices }, { targetRatio = 0.5, targetFaces } = {}) {
  const V = positions.length / 3;
  const F0 = indices.length / 3;
  const target = Math.max(4, Math.round(targetFaces ?? F0 * targetRatio));

  const pos = Float64Array.from(positions);
  const faceVerts = Int32Array.from(indices);
  const faceAlive = new Uint8Array(F0).fill(1);

  const vertexFaces = Array.from({ length: V }, () => new Set());
  const neighbors = Array.from({ length: V }, () => new Set());
  const version = new Uint32Array(V);
  const quadrics = new Float64Array(V * 10);

  // ---- 初始化：顶点-面、顶点邻域、每个顶点的二次误差矩阵 ----
  const normals = computeFaceNormals(positions, indices);
  for (let f = 0; f < F0; f++) {
    const i0 = faceVerts[f * 3];
    const i1 = faceVerts[f * 3 + 1];
    const i2 = faceVerts[f * 3 + 2];
    vertexFaces[i0].add(f);
    vertexFaces[i1].add(f);
    vertexFaces[i2].add(f);
    neighbors[i0].add(i1).add(i2);
    neighbors[i1].add(i0).add(i2);
    neighbors[i2].add(i0).add(i1);

    const nx = normals[f * 3];
    const ny = normals[f * 3 + 1];
    const nz = normals[f * 3 + 2];
    const [p0, p1, p2] = [
      [pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]],
      [pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]],
      [pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]],
    ];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 0.5;
    const d = -(nx * p0[0] + ny * p0[1] + nz * p0[2]);
    const w = Math.max(area, 1e-12);

    for (const i of [i0, i1, i2]) {
      const o = i * 10;
      quadrics[o] += w * nx * nx;
      quadrics[o + 1] += w * nx * ny;
      quadrics[o + 2] += w * nx * nz;
      quadrics[o + 3] += w * nx * d;
      quadrics[o + 4] += w * ny * ny;
      quadrics[o + 5] += w * ny * nz;
      quadrics[o + 6] += w * ny * d;
      quadrics[o + 7] += w * nz * nz;
      quadrics[o + 8] += w * nz * d;
      quadrics[o + 9] += w * d * d;
    }
  }

  const heap = new MinHeap();
  const seenEdge = new Set();

  const sumQuadric = new Float64Array(10);
  const pushEdge = (u, v) => {
    if (u === v) return;
    const key = u < v ? `${u}_${v}` : `${v}_${u}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);

    for (let k = 0; k < 10; k++) sumQuadric[k] = quadrics[u * 10 + k] + quadrics[v * 10 + k];
    const px = pos[u * 3], py = pos[u * 3 + 1], pz = pos[u * 3 + 2];
    const qx = pos[v * 3], qy = pos[v * 3 + 1], qz = pos[v * 3 + 2];

    const optimal = optimalPoint(sumQuadric, px, py, pz, qx, qy, qz);
    let target3 = optimal;
    let cost;
    if (target3) {
      cost = quadricCost(sumQuadric, target3[0], target3[1], target3[2]);
    } else {
      // 退化时比较中点与两端点，取代价最小者
      const mid = [(px + qx) / 2, (py + qy) / 2, (pz + qz) / 2];
      const cand = [mid, [px, py, pz], [qx, qy, qz]];
      let best = Infinity;
      for (const c of cand) {
        const val = quadricCost(sumQuadric, c[0], c[1], c[2]);
        if (val < best) {
          best = val;
          target3 = c;
        }
      }
      cost = best;
    }

    heap.push({ cost, u, v, vu: version[u], vv: version[v], p: target3 });
  };

  // 初始边集合
  const initialEdges = new Map();
  for (let f = 0; f < F0; f++) {
    for (let k = 0; k < 3; k++) {
      const x = faceVerts[f * 3 + k];
      const y = faceVerts[f * 3 + ((k + 1) % 3)];
      const kk = x < y ? `${x}_${y}` : `${y}_${x}`;
      if (!initialEdges.has(kk)) initialEdges.set(kk, [Math.min(x, y), Math.max(x, y)]);
    }
  }
  for (const [a, b] of initialEdges.values()) pushEdge(a, b);

  let faceCount = F0;
  let guard = 0;

  while (faceCount > target && heap.size && guard++ < F0 * 8) {
    const item = heap.pop();
    const { u, v } = item;
    if (version[u] !== item.vu || version[v] !== item.vv) continue; // 已失效

    const [px, py, pz] = item.p;

    // ---- 链接条件：共享邻居必须是 1（边界）或 2（内部），否则会产生非流形 ----
    let shared = 0;
    for (const w of neighbors[u]) if (neighbors[v].has(w)) shared++;
    if (shared < 1 || shared > 2) continue;

    // ---- 折叠后不得出现翻转或退化面片 ----
    let ok = true;
    const checkFace = (f) => {
      const a = faceVerts[f * 3];
      const b = faceVerts[f * 3 + 1];
      const c = faceVerts[f * 3 + 2];
      const hasU = a === u || b === u || c === u;
      const hasV = a === v || b === v || c === v;
      // 同时包含 u、v 的面片折叠后会消失，无需检查
      if (hasU && hasV) return true;

      const coord = (i) => {
        if (i === u || i === v) return [px, py, pz];
        return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      };
      const [A, B, C] = [coord(a), coord(b), coord(c)];
      const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2];
      const e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) return false;

      // 与折叠前的法向比较
      const oldA = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];
      const oldB = [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]];
      const oldC = [pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]];
      const ou = [oldB[0] - oldA[0], oldB[1] - oldA[1], oldB[2] - oldA[2]];
      const ov = [oldC[0] - oldA[0], oldC[1] - oldA[1], oldC[2] - oldA[2]];
      const onx = ou[1] * ov[2] - ou[2] * ov[1];
      const ony = ou[2] * ov[0] - ou[0] * ov[2];
      const onz = ou[0] * ov[1] - ou[1] * ov[0];
      const olen = Math.hypot(onx, ony, onz) || 1;
      const dot = (nx * onx + ny * ony + nz * onz) / (len * olen);
      return dot > 0.1;
    };

    for (const f of vertexFaces[u]) {
      if (!faceAlive[f]) continue;
      if (!checkFace(f)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (const f of vertexFaces[v]) {
        if (!faceAlive[f]) continue;
        if (!checkFace(f)) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;

    // ---- 执行折叠：v 合并到 u ----
    pos[u * 3] = px;
    pos[u * 3 + 1] = py;
    pos[u * 3 + 2] = pz;
    for (let k = 0; k < 10; k++) quadrics[u * 10 + k] += quadrics[v * 10 + k];

    for (const f of vertexFaces[v]) {
      if (!faceAlive[f]) continue;
      let hasU = false;
      for (let k = 0; k < 3; k++) {
        if (faceVerts[f * 3 + k] === u) hasU = true;
      }
      if (hasU) {
        // 折叠后出现重复顶点 → 面片消失
        faceAlive[f] = 0;
        faceCount--;
        for (let k = 0; k < 3; k++) vertexFaces[faceVerts[f * 3 + k]].delete(f);
        continue;
      }
      for (let k = 0; k < 3; k++) {
        if (faceVerts[f * 3 + k] === v) faceVerts[f * 3 + k] = u;
      }
      vertexFaces[u].add(f);
    }

    for (const w of neighbors[v]) {
      neighbors[w].delete(v);
      if (w !== u) {
        neighbors[w].add(u);
        neighbors[u].add(w);
      }
    }
    neighbors[u].delete(v);
    neighbors[v].clear();
    vertexFaces[v].clear();

    version[u]++;
    version[v] = 0xffffffff;

    // 受影响边的代价重新入堆
    for (const w of neighbors[u]) {
      if (version[w] === 0xffffffff) continue;
      const key = u < w ? `${u}_${w}` : `${w}_${u}`;
      seenEdge.delete(key);
      pushEdge(u, w);
    }
  }

  // ---- 压实输出 ----
  const remap = new Int32Array(V).fill(-1);
  const outPos = [];
  for (let i = 0; i < V; i++) {
    if (version[i] === 0xffffffff) continue;
    if (vertexFaces[i].size === 0) continue;
    remap[i] = outPos.length / 3;
    outPos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  }

  const outIdx = [];
  for (let f = 0; f < F0; f++) {
    if (!faceAlive[f]) continue;
    const a = remap[faceVerts[f * 3]];
    const b = remap[faceVerts[f * 3 + 1]];
    const c = remap[faceVerts[f * 3 + 2]];
    if (a < 0 || b < 0 || c < 0) continue;
    outIdx.push(a, b, c);
  }

  return {
    positions: new Float32Array(outPos),
    indices: new Uint32Array(outIdx),
    facesIn: F0,
    facesOut: outIdx.length / 3,
  };
}
