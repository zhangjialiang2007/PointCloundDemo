/**
 * 面片清洗：删除退化三角（零面积、扁长三角）、自交面片，统一法向朝向。
 */
import { computeFaceAreas, edgeKey } from './mesh.js';

const EPS = 1e-9;

/** 读取第 f 个三角面的三个顶点坐标 */
export function faceVertices(positions, indices, f) {
  const a = indices[f * 3] * 3;
  const b = indices[f * 3 + 1] * 3;
  const c = indices[f * 3 + 2] * 3;
  return [
    [positions[a], positions[a + 1], positions[a + 2]],
    [positions[b], positions[b + 1], positions[b + 2]],
    [positions[c], positions[c + 1], positions[c + 2]],
  ];
}

/**
 * 退化面片检测。
 * 判据零（始终生效）：三个顶点索引有重复，面片无几何意义；
 * 判据一（areaRatio > 0 时生效）：面积 < 平均面积 × areaRatio；
 * 判据二（aspectMin > 0 时生效）：面积 / 最长边² < aspectMin（等边三角形为 0.433，越小越扁长）。
 * 默认两个阈值都为 0，即只删索引重复的无效面：重建/扫描网格里的细长三角是合法几何，
 * 按面积或长宽比批量剔除会在闭合曲面上打洞，甚至把网格剪成多块。
 */
export function findDegenerateFaces(positions, indices, { areaRatio = 0, aspectMin = 0 } = {}) {
  const areas = computeFaceAreas(positions, indices);
  const F = areas.length;
  let sum = 0;
  for (let f = 0; f < F; f++) sum += areas[f];
  const eps = (sum / Math.max(F, 1)) * areaRatio;

  const bad = new Set();
  for (let f = 0; f < F; f++) {
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];
    if (a === b || b === c || c === a) {
      bad.add(f);
      continue;
    }
    if (areaRatio > 0 && areas[f] < eps) {
      bad.add(f);
      continue;
    }
    if (aspectMin <= 0) continue;
    const [p0, p1, p2] = faceVertices(positions, indices, f);
    const longest = Math.max(
      Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]),
      Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]),
      Math.hypot(p0[0] - p2[0], p0[1] - p2[1], p0[2] - p2[2]),
    );
    if (longest > 0 && areas[f] / (longest * longest) < aspectMin) bad.add(f);
  }
  return bad;
}

/** 线段与三角形求交（Möller–Trumbore，共面情形忽略） */
function segmentTriangle(a, b, t) {
  const [p0, p1, p2] = t;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
  const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];

  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < EPS) return false;

  const inv = 1 / det;
  const sx = a[0] - p0[0], sy = a[1] - p0[1], sz = a[2] - p0[2];
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return false;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;

  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt > 1e-6 && tt < 1 - 1e-6;
}

/** 两三角形是否相交：6 条边分别与对方求交 */
export function trianglesIntersect(t1, t2) {
  return (
    segmentTriangle(t1[0], t1[1], t2) ||
    segmentTriangle(t1[1], t1[2], t2) ||
    segmentTriangle(t1[2], t1[0], t2) ||
    segmentTriangle(t2[0], t2[1], t1) ||
    segmentTriangle(t2[1], t2[2], t1) ||
    segmentTriangle(t2[2], t2[0], t1)
  );
}

/**
 * 自交面片检测：均匀网格粗筛 + 精确求交，共享顶点的相邻面片跳过。
 */
export function findSelfIntersectingFaces(positions, indices, { maxTests = 3e6 } = {}) {
  const F = indices.length / 3;
  const areas = computeFaceAreas(positions, indices);
  let sum = 0;
  for (let f = 0; f < F; f++) sum += areas[f];
  const cell = Math.max(Math.sqrt(sum / Math.max(F, 1)) * 3, 1e-6);

  // 包围盒
  const boxes = new Float32Array(F * 6);
  for (let f = 0; f < F; f++) {
    const [p0, p1, p2] = faceVertices(positions, indices, f);
    for (let k = 0; k < 3; k++) {
      boxes[f * 6 + k] = Math.min(p0[k], p1[k], p2[k]);
      boxes[f * 6 + 3 + k] = Math.max(p0[k], p1[k], p2[k]);
    }
  }

  // 面片登记到覆盖的格子
  const grid = new Map();
  for (let f = 0; f < F; f++) {
    const x0 = Math.floor(boxes[f * 6] / cell);
    const y0 = Math.floor(boxes[f * 6 + 1] / cell);
    const z0 = Math.floor(boxes[f * 6 + 2] / cell);
    const x1 = Math.floor(boxes[f * 6 + 3] / cell);
    const y1 = Math.floor(boxes[f * 6 + 4] / cell);
    const z1 = Math.floor(boxes[f * 6 + 5] / cell);
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const key = `${x},${y},${z}`;
          const bucket = grid.get(key);
          if (bucket) bucket.push(f);
          else grid.set(key, [f]);
        }
      }
    }
  }

  const bad = new Set();
  const tested = new Set();
  let tests = 0;

  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const fa = bucket[i];
        const fb = bucket[j];
        const pairKey = fa < fb ? fa * F + fb : fb * F + fa;
        if (tested.has(pairKey)) continue;
        tested.add(pairKey);

        // 共享顶点 → 属于相邻面片，跳过
        const a0 = indices[fa * 3], a1 = indices[fa * 3 + 1], a2 = indices[fa * 3 + 2];
        const b0 = indices[fb * 3], b1 = indices[fb * 3 + 1], b2 = indices[fb * 3 + 2];
        if (
          a0 === b0 || a0 === b1 || a0 === b2 ||
          a1 === b0 || a1 === b1 || a1 === b2 ||
          a2 === b0 || a2 === b1 || a2 === b2
        ) continue;

        if (
          boxes[fa * 6] > boxes[fb * 6 + 3] || boxes[fb * 6] > boxes[fa * 6 + 3] ||
          boxes[fa * 6 + 1] > boxes[fb * 6 + 4] || boxes[fb * 6 + 1] > boxes[fa * 6 + 4] ||
          boxes[fa * 6 + 2] > boxes[fb * 6 + 5] || boxes[fb * 6 + 2] > boxes[fa * 6 + 5]
        ) continue;

        if (++tests > maxTests) return bad;
        if (trianglesIntersect(faceVertices(positions, indices, fa), faceVertices(positions, indices, fb))) {
          bad.add(fa);
          bad.add(fb);
        }
      }
    }
  }
  return bad;
}

/**
 * 统一法向朝向：沿共享边广度优先传播一致朝向，再按有符号体积判断是否需要整体翻转。
 * @returns {{indices: Uint32Array, flipped: number}}
 */
export function fixOrientation(positions, indices) {
  const F = indices.length / 3;
  const out = new Uint32Array(indices);

  // 边 → 相邻面片（记录该边在面片内的方向）
  const edges = new Map();
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 3; k++) {
      const x = out[f * 3 + k];
      const y = out[f * 3 + ((k + 1) % 3)];
      const key = edgeKey(x, y);
      const item = { face: f, forward: x < y };
      const rec = edges.get(key);
      if (rec) rec.push(item);
      else edges.set(key, [item]);
    }
  }

  const visited = new Uint8Array(F);
  const flip = new Uint8Array(F);
  const queue = [];

  for (let seed = 0; seed < F; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    queue.length = 0;
    queue.push(seed);
    const component = [];
    // 部件是否闭合：存在边界边或非流形边的部件无法用体积判断内外，应保持传播出的一致朝向
    let closed = true;

    for (let head = 0; head < queue.length; head++) {
      const f = queue[head];
      component.push(f);
      for (let k = 0; k < 3; k++) {
        const x = out[f * 3 + k];
        const y = out[f * 3 + ((k + 1) % 3)];
        const rec = edges.get(edgeKey(x, y));
        if (!rec || rec.length !== 2) {
          closed = false;
          continue;
        }

        const selfItem = rec[0].face === f ? rec[0] : rec[1];
        const other = rec[0].face === f ? rec[1] : rec[0];
        // 同一条边在两个面片内方向相同 → 朝向相反，需要翻转
        const wantFlip = flip[f] ^ (other.forward === selfItem.forward ? 1 : 0);
        if (!visited[other.face]) {
          visited[other.face] = 1;
          flip[other.face] = wantFlip;
          queue.push(other.face);
        }
      }
    }

    // 有符号体积：为负说明整个部件朝内，需要整体翻转。
    // 以部件内一个顶点为参考点，避免大坐标（BIM 坐标）下各项巨大、靠相互抵消取符号而失真。
    let volume = 0;
    const ref = component[0];
    const rx = positions[out[ref * 3] * 3];
    const ry = positions[out[ref * 3] * 3 + 1];
    const rz = positions[out[ref * 3] * 3 + 2];
    for (const f of component) {
      const ai = out[f * 3] * 3;
      const bi = out[f * 3 + 1] * 3;
      const ci = out[f * 3 + 2] * 3;
      const ax = positions[ai] - rx, ay = positions[ai + 1] - ry, az = positions[ai + 2] - rz;
      const bx = positions[bi] - rx, by = positions[bi + 1] - ry, bz = positions[bi + 2] - rz;
      const cx = positions[ci] - rx, cy = positions[ci + 1] - ry, cz = positions[ci + 2] - rz;
      const v =
        ax * (by * cz - bz * cy) +
        ay * (bz * cx - bx * cz) +
        az * (bx * cy - by * cx);
      volume += flip[f] ? -v : v;
    }
    if (closed && volume < 0) {
      for (const f of component) flip[f] ^= 1;
    }
  }

  let flipped = 0;
  for (let f = 0; f < F; f++) {
    if (!flip[f]) continue;
    flipped++;
    const tmp = out[f * 3 + 1];
    out[f * 3 + 1] = out[f * 3 + 2];
    out[f * 3 + 2] = tmp;
  }
  return { indices: out, flipped };
}

/** 按面片索引过滤，返回新的索引数组 */
export function removeFaces(indices, removeSet) {
  const kept = [];
  for (let f = 0; f < indices.length / 3; f++) {
    if (removeSet.has(f)) continue;
    kept.push(indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]);
  }
  return new Uint32Array(kept);
}

/**
 * 完整清洗流程：退化剔除 → 自交剔除 → 法向统一。
 * @returns {{mesh: {positions: Float32Array, indices: Uint32Array}, stats: object, bad: Set<number>}}
 */
export function cleanMesh(
  { positions, indices },
  { areaRatio = 0, aspectMin = 0, removeSelfIntersect = true, fixNormals = true } = {},
) {
  const facesIn = indices.length / 3;
  const degenerate = findDegenerateFaces(positions, indices, { areaRatio, aspectMin });
  const selfIntersect = removeSelfIntersect ? findSelfIntersectingFaces(positions, indices) : new Set();

  const remove = new Set([...degenerate, ...selfIntersect]);
  let cleanIndices = removeFaces(indices, remove);

  let flipped = 0;
  if (fixNormals && cleanIndices.length >= 3) {
    const res = fixOrientation(positions, cleanIndices);
    cleanIndices = res.indices;
    flipped = res.flipped;
  }

  return {
    mesh: { positions, indices: cleanIndices },
    bad: remove,
    stats: {
      facesIn,
      degenerate: degenerate.size,
      selfIntersect: selfIntersect.size,
      removed: remove.size,
      flipped,
      facesOut: cleanIndices.length / 3,
    },
  };
}

