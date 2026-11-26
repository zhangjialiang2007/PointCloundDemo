/**
 * 三角网格基础工具：面积/法向、边-面关系、程序化球面网格。
 * 网格统一用 { positions: Float32Array, indices: Uint32Array } 表示。
 */

/** 每个三角面的面积 */
export function computeFaceAreas(positions, indices) {
  const F = indices.length / 3;
  const areas = new Float32Array(F);
  for (let f = 0; f < F; f++) {
    const a = indices[f * 3] * 3;
    const b = indices[f * 3 + 1] * 3;
    const c = indices[f * 3 + 2] * 3;

    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];

    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    areas[f] = Math.hypot(nx, ny, nz) * 0.5;
  }
  return areas;
}

/** 每个三角面的单位法向（绕序决定朝向） */
export function computeFaceNormals(positions, indices) {
  const F = indices.length / 3;
  const normals = new Float32Array(F * 3);
  for (let f = 0; f < F; f++) {
    const a = indices[f * 3] * 3;
    const b = indices[f * 3 + 1] * 3;
    const c = indices[f * 3 + 2] * 3;

    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    normals[f * 3] = nx;
    normals[f * 3 + 1] = ny;
    normals[f * 3 + 2] = nz;
  }
  return normals;
}

/** 顶点法向（面积加权），用于平滑着色 */
export function computeVertexNormals(positions, indices) {
  const V = positions.length / 3;
  const normals = new Float32Array(V * 3);
  for (let f = 0; f < indices.length; f += 3) {
    const ia = indices[f] * 3;
    const ib = indices[f + 1] * 3;
    const ic = indices[f + 2] * 3;

    const ux = positions[ib] - positions[ia];
    const uy = positions[ib + 1] - positions[ia + 1];
    const uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia];
    const vy = positions[ic + 1] - positions[ia + 1];
    const vz = positions[ic + 2] - positions[ia + 2];

    // 叉积长度已含 2 倍面积，天然是面积加权
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    normals[ia] += nx;
    normals[ia + 1] += ny;
    normals[ia + 2] += nz;
    normals[ib] += nx;
    normals[ib + 1] += ny;
    normals[ib + 2] += nz;
    normals[ic] += nx;
    normals[ic + 1] += ny;
    normals[ic + 2] += nz;
  }

  for (let i = 0; i < V; i++) {
    const x = normals[i * 3];
    const y = normals[i * 3 + 1];
    const z = normals[i * 3 + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / len;
    normals[i * 3 + 1] = y / len;
    normals[i * 3 + 2] = z / len;
  }
  return normals;
}

/** 边键（小索引在前） */
export function edgeKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * 构建边-面关系。
 * @returns {Map<string, {a: number, b: number, faces: number[]}>}
 */
export function buildEdgeFaces(indices) {
  const map = new Map();
  for (let f = 0; f < indices.length / 3; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];
    for (const [x, y] of [
      [i0, i1],
      [i1, i2],
      [i2, i0],
    ]) {
      const key = edgeKey(x, y);
      let rec = map.get(key);
      if (!rec) {
        rec = { a: Math.min(x, y), b: Math.max(x, y), faces: [] };
        map.set(key, rec);
      }
      rec.faces.push(f);
    }
  }
  return map;
}

/** 顶点邻接表（每个顶点相邻的顶点集合） */
export function buildVertexNeighbors(indices, vertexCount) {
  const neighbors = Array.from({ length: vertexCount }, () => new Set());
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f];
    const b = indices[f + 1];
    const c = indices[f + 2];
    neighbors[a].add(b).add(c);
    neighbors[b].add(a).add(c);
    neighbors[c].add(a).add(b);
  }
  return neighbors;
}

/** 起伏球面的半径函数（与点云生成器保持一致的形状） */
export function blobRadius(theta, phi) {
  return 1 + 0.22 * Math.sin(3 * theta) * Math.sin(2 * phi) + 0.12 * Math.cos(5 * phi);
}

/**
 * 生成起伏球面（icosphere 细分）网格。
 * @param {number} subdivisions 细分次数，面数 = 20 * 4^n
 * @param {number} radius 基础半径
 * @returns {{positions: Float32Array, indices: Uint32Array}}
 */
export function generateBlobMesh(subdivisions = 4, radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let verts = base.map((v) => {
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  });

  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < subdivisions; s++) {
    const midCache = new Map();
    const midpoint = (i, j) => {
      const key = i < j ? `${i}_${j}` : `${j}_${i}`;
      const cached = midCache.get(key);
      if (cached !== undefined) return cached;

      const ax = verts[i][0] + verts[j][0];
      const ay = verts[i][1] + verts[j][1];
      const az = verts[i][2] + verts[j][2];
      const len = Math.hypot(ax, ay, az);
      verts.push([ax / len, ay / len, az / len]);
      const idx = verts.length - 1;
      midCache.set(key, idx);
      return idx;
    };

    const next = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }

  // 沿法向做起伏变形，得到闭合的凹凸球面
  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    const [x, y, z] = verts[i];
    const theta = Math.atan2(z, x);
    const phi = Math.acos(Math.max(-1, Math.min(1, y)));
    const r = radius * blobRadius(theta, phi);
    positions[i * 3] = x * r;
    positions[i * 3 + 1] = y * r;
    positions[i * 3 + 2] = z * r;
  }

  const indices = new Uint32Array(faces.length * 3);
  for (let f = 0; f < faces.length; f++) {
    indices[f * 3] = faces[f][0];
    indices[f * 3 + 1] = faces[f][1];
    indices[f * 3 + 2] = faces[f][2];
  }

  return { positions, indices };
}
