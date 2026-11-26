/**
 * 除泊松之外的两种点云三角化算法（教学用简化实现）：
 *  - BPA 球旋转法（Ball Pivoting）：以给定半径的球在点云上滚动，
 *    球面贴住三个点时生成三角面；用「空球判据（球内无其他点）」保证贴合。
 *  - 空球判据三角化（快速）：不去滚动球，而是直接枚举每个点的邻居对，
 *    同样用空球判据筛出 Delaunay 三角形，一遍遍历即可出网格。
 *
 * 两者判据相同，差别在于「是否沿前沿滚动生长」。
 */

/** 默认球半径：取平均最近邻间距的倍数（随机采样下须留出足够连通余量） */
const RADIUS_FACTOR = 2.5;


/**
 * 均匀网格索引，用于半径邻域查询。
 * @param {Float32Array} positions
 */
function buildGrid(positions) {
  const n = positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const cell = Math.max((extent / Math.cbrt(n)) * 1.8, 1e-6);

  const map = new Map();
  for (let i = 0; i < n; i++) {
    const key =
      `${Math.floor(positions[i * 3] / cell)},` +
      `${Math.floor(positions[i * 3 + 1] / cell)},` +
      `${Math.floor(positions[i * 3 + 2] / cell)}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(i);
    else map.set(key, [i]);
  }
  return { map, cell, extent };
}

/**
 * 遍历半径内的所有点。
 * @returns {number} 命中点数
 */
function forEachNear(grid, positions, px, py, pz, radius, cb) {
  const { map, cell } = grid;
  const r2 = radius * radius;
  const ring = Math.max(1, Math.ceil(radius / cell));
  const cx = Math.floor(px / cell);
  const cy = Math.floor(py / cell);
  const cz = Math.floor(pz / cell);
  let hits = 0;

  for (let dx = -ring; dx <= ring; dx++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dz = -ring; dz <= ring; dz++) {
        const bucket = map.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const j = bucket[b];
          const ddx = positions[j * 3] - px;
          const ddy = positions[j * 3 + 1] - py;
          const ddz = positions[j * 3 + 2] - pz;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 > r2) continue;
          hits++;
          cb(j, d2);
        }
      }
    }
  }
  return hits;
}

/** 估算平均点间距：抽样取每个点到最近邻的距离均值 */
export function estimateSpacing(positions) {
  const n = positions.length / 3;
  const grid = buildGrid(positions);
  const step = Math.max(1, Math.floor(n / 1500));
  let sum = 0;
  let count = 0;

  for (let i = 0; i < n; i += step) {
    let best = Infinity;
    // 逐环扩大，找到最近邻就停
    for (let r = grid.cell; r < grid.extent * 0.5; r *= 1.6) {
      forEachNear(grid, positions, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], r, (j, d2) => {
        if (j !== i && d2 < best) best = d2;
      });
      if (best < Infinity) break;
    }
    if (best < Infinity) {
      sum += Math.sqrt(best);
      count++;
    }
  }
  return count ? sum / count : grid.extent / 100;
}

/** 三角面外接圆圆心与半径 */
function circumcircle(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;

  // n = u × v
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const n2 = nx * nx + ny * ny + nz * nz;
  if (n2 < 1e-18) return null; // 三点共线

  const u2 = ux * ux + uy * uy + uz * uz;
  const v2 = vx * vx + vy * vy + vz * vz;

  // v × n 与 n × u
  const p1x = vy * nz - vz * ny, p1y = vz * nx - vx * nz, p1z = vx * ny - vy * nx;
  const p2x = ny * uz - nz * uy, p2y = nz * ux - nx * uz, p2z = nx * uy - ny * ux;

  const inv = 1 / (2 * n2);
  const ox = ax + (u2 * p1x + v2 * p2x) * inv;
  const oy = ay + (u2 * p1y + v2 * p2y) * inv;
  const oz = az + (u2 * p1z + v2 * p2z) * inv;

  const ex = ax - ox, ey = ay - oy, ez = az - oz;
  return { ox, oy, oz, radius: Math.hypot(ex, ey, ez) };
}

/** 三角形单位法向 */
function faceNormal(positions, a, b, c) {
  const ux = positions[b * 3] - positions[a * 3];
  const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
  const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
  const vx = positions[c * 3] - positions[a * 3];
  const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
  const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * 三角面法向与三个顶点法向的平均余弦（-1~1）。
 * 用于：① 判定绕序（>0 表示朝向与点法向一致）；② 剔除跨壁"桥接面"（余弦接近 0）。
 */
function alignment(positions, normals, a, b, c, fn) {
  let sx = 0, sy = 0, sz = 0;
  for (const v of [a, b, c]) {
    sx += normals[v * 3];
    sy += normals[v * 3 + 1];
    sz += normals[v * 3 + 2];
  }
  const len = Math.hypot(sx, sy, sz) || 1;
  return (fn[0] * sx + fn[1] * sy + fn[2] * sz) / len;
}

/** 去掉未被引用的顶点，便于导出与统计 */
function compact(positions, faces) {
  const V = positions.length / 3;
  const remap = new Int32Array(V).fill(-1);
  const outPositions = [];
  const indices = new Uint32Array(faces.length * 3);

  for (let f = 0; f < faces.length; f++) {
    for (let k = 0; k < 3; k++) {
      const v = faces[f][k];
      if (remap[v] < 0) {
        remap[v] = outPositions.length / 3;
        outPositions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
      }
      indices[f * 3 + k] = remap[v];
    }
  }
  return { positions: new Float32Array(outPositions), indices };
}

/**
 * 前沿边生长框架。
 * @param {Float32Array} positions 点坐标
 * @param {Float32Array} normals 单位法向（用于朝向一致性判断）
 * @param {object} options radius（球半径）/ k（邻域上限）/ emptyBall（是否启用空球判据）
 * @returns {{positions: Float32Array, indices: Uint32Array, triangles: number}}
 */
function growFront(positions, normals, { radius, k = 20, emptyBall }) {
  const n = positions.length / 3;
  if (n < 8) throw new Error('点数过少，无法重建');

  const grid = buildGrid(positions);
  const ballR = radius > 0 ? radius : estimateSpacing(positions) * RADIUS_FACTOR;
  // 邻域半径必须与球半径同尺度：过大会引入跨片候选，过小则连通性不足
  const searchR = ballR * 1.7;

  // 每个点的候选邻域（按距离升序，k 仅作安全上限），避免前沿扩张时反复查询
  const neighbors = new Array(n);
  for (let i = 0; i < n; i++) {
    const list = [];
    forEachNear(grid, positions, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], searchR, (j, d2) => {
      if (j === i) return;
      list.push({ j, d2 });
    });
    list.sort((p, q) => p.d2 - q.d2);
    neighbors[i] = list.length > k ? list.slice(0, k) : list;
  }

  const faces = []; // [a,b,c]
  const faceKeys = new Set(); // 三角形去重
  const edgeUse = new Map(); // 边被引用的次数
  const front = []; // 待生长边 [a,b]
  const used = new Uint8Array(n); // 顶点是否已参与网格，用于补种子

  const edgeKeyOf = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const faceKeyOf = (a, b, c) => [a, b, c].sort((x, y) => x - y).join('_');

  const align3 = (a, b, c, fn) => alignment(positions, normals, a, b, c, fn);

  const addFace = (a, b, c) => {
    const key = faceKeyOf(a, b, c);
    if (faceKeys.has(key)) return false;
    faceKeys.add(key);

    // 朝向与顶点法向一致，保证整片网格绕序统一
    const fn = faceNormal(positions, a, b, c);
    const face = align3(a, b, c, fn) > 0 ? [a, b, c] : [a, c, b];
    faces.push(face);
    used[a] = used[b] = used[c] = 1;

    for (const [x, y] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
      const ek = edgeKeyOf(x, y);
      const used = (edgeUse.get(ek) ?? 0) + 1;
      edgeUse.set(ek, used);
      if (used < 2) front.push([x, y]);
    }
    return true;
  };

  // ---- 前沿生长 ----
  const maxFaces = n * 2.5; // 面数上限，防止异常数据导致无限扩张
  const maxEdge = ballR * (emptyBall ? 1.6 : 1.5); // 边长上限，避免拉出跨壁面
  const cosMin = emptyBall ? 0.3 : 0.45;
  const emptyTol = 0.85; // 空球判据保留 15% 容差，兼容采样疏密不均

  const distance = (i, j) =>
    Math.hypot(
      positions[i * 3] - positions[j * 3],
      positions[i * 3 + 1] - positions[j * 3 + 1],
      positions[i * 3 + 2] - positions[j * 3 + 2],
    );

  /** 以 i 为顶点找一个种子面，成功返回 true */
  const seedAt = (i) => {
    const nb = neighbors[i];
    const seedRadius = emptyBall ? ballR : ballR * 1.3;
    for (let s = 0; s < nb.length; s++) {
      const j = nb[s].j;
      for (let t = s + 1; t < nb.length; t++) {
        const m = nb[t].j;
        if (faceKeys.has(faceKeyOf(i, j, m))) continue;
        const cc = circumcircle(
          positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
          positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2],
          positions[m * 3], positions[m * 3 + 1], positions[m * 3 + 2],
        );
        if (!cc || cc.radius > seedRadius) continue;
        if (Math.max(distance(i, j), distance(i, m), distance(j, m)) > maxEdge) continue;
        if (Math.abs(align3(i, j, m, faceNormal(positions, i, j, m))) < cosMin) continue;
        if (addFace(i, j, m)) return true;
      }
    }
    return false;
  };

  /**
   * 前沿边 (a,b) 选一个候选点连面，返回候选点索引（-1 表示无）。
   * allowUsed=false 时只接受尚未入网格的点，便于前沿先向外扩张、再回填闭合。
   */
  const pickCandidate = (a, b, allowUsed) => {
    const e0 = distance(a, b);
    let best = -1;
    let bestScore = Infinity;

    // 候选点 = 两端点邻域的并集
    for (const list of [neighbors[a], neighbors[b]]) {
      for (let s = 0; s < list.length; s++) {
        const c = list[s].j;
        if (c === a || c === b) continue;
        if (!allowUsed && used[c]) continue;
        if (faceKeys.has(faceKeyOf(a, b, c))) continue;
        if ((edgeUse.get(edgeKeyOf(a, c)) ?? 0) >= 2) continue;
        if ((edgeUse.get(edgeKeyOf(b, c)) ?? 0) >= 2) continue;

        const longest = Math.max(e0, distance(a, c), distance(b, c));
        if (longest > maxEdge) continue;

        const cc = circumcircle(
          positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
          positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
          positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2],
        );
        if (!cc) continue;
        // 扁长面（钝角）剔除
        if (cc.radius > longest * 1.05) continue;

        // 与顶点法向的贴合度：取绝对值，负号只代表绕序相反（addFace 会纠正）
        const cos = Math.abs(align3(a, b, c, faceNormal(positions, a, b, c)));
        if (cos < cosMin) continue;

        if (emptyBall) {
          if (cc.radius > ballR) continue;
          // 空球判据：外接球内不得包含其他点，球才能真正"贴"在这三个点上
          let occupied = false;
          const limit = cc.radius * emptyTol;
          forEachNear(grid, positions, cc.ox, cc.oy, cc.oz, limit, (j) => {
            if (occupied || j === a || j === b || j === c) return;
            const dx = positions[j * 3] - cc.ox;
            const dy = positions[j * 3 + 1] - cc.oy;
            const dz = positions[j * 3 + 2] - cc.oz;
            if (dx * dx + dy * dy + dz * dz < limit * limit) occupied = true;
          });
          if (occupied) continue;
          // 球越小越贴合，优先取最紧的三角形（即球"翻滚"到的位置）
          if (cc.radius < bestScore) {
            bestScore = cc.radius;
            best = c;
          }
        } else {
          // 贪心：优先取最长边最短的三角形
          const score = longest + cc.radius * 0.25;
          if (score < bestScore) {
            bestScore = score;
            best = c;
          }
        }
      }
    }
    return best;
  };

  // 前沿生长主循环：前沿耗尽后从未使用的点重新起种子，直到面数上限或无可生长点
  let frontCursor = 0;
  let scanCursor = 0;
  while (faces.length < maxFaces) {
    while (frontCursor < front.length && faces.length < maxFaces) {
      const [a, b] = front[frontCursor++];
      if ((edgeUse.get(edgeKeyOf(a, b)) ?? 0) >= 2) continue;
      if (distance(a, b) > maxEdge) continue;
      // 先只用新顶点扩张，找不到时再允许回填已入网格的点
      let best = pickCandidate(a, b, false);
      if (best < 0) best = pickCandidate(a, b, true);
      if (best >= 0) addFace(a, b, best);
    }

    let seeded = false;
    for (; scanCursor < n; scanCursor++) {
      if (used[scanCursor]) continue;
      if (seedAt(scanCursor)) {
        scanCursor++;
        seeded = true;
        break;
      }
    }
    if (!seeded) break;
  }

  if (faces.length === 0) throw new Error('未能生成三角面，请调大球半径');
  const mesh = compact(positions, faces);
  return { positions: mesh.positions, indices: mesh.indices, triangles: faces.length };
}

/**
 * BPA 球旋转法重建。
 * @param {Float32Array} positions 点坐标
 * @param {Float32Array} normals 单位法向
 * @param {{radius?: number, k?: number}} options radius 球半径（0 表示按平均点间距自动估算）
 */
export function ballPivotReconstruct(positions, normals, { radius = 0, k = 20 } = {}) {
  return growFront(positions, normals, { radius, k, emptyBall: true });
}

/**
 * 空球判据三角化（快速）：逐点枚举「本点 + 最近 k 个邻居中的任意两点」组成候选三角形，
 * 只保留外接球内无其他点的那些（空球 / Delaunay 判据）；每个面只由编号最小的顶点生成。
 * 相比 BPA 的区域生长，这里不做前沿推进，一遍遍历即可得到近似 Delaunay 网格。
 * @param {Float32Array} positions 点坐标
 * @param {Float32Array} normals 单位法向
 * @param {{radius?: number, k?: number}} options radius 球半径（0 表示自动估算）、k 邻域点数
 */
export function fastReconstruct(positions, normals, { radius = 0, k = 12 } = {}) {
  const n = positions.length / 3;
  if (n < 8) throw new Error('点数过少，无法重建');

  const grid = buildGrid(positions);
  const ballR = radius > 0 ? radius : estimateSpacing(positions) * RADIUS_FACTOR;
  const maxEdge = ballR * 1.6;

  const faces = [];
  const edgeUse = new Map(); // 无向边引用次数
  const edgeKeyOf = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const maxEdge2 = maxEdge * maxEdge;

  /** 登记一个三角面（调用方保证不重复、不超流形上限） */
  const addFace = (a, b, c) => {
    faces.push([a, b, c]);
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const ek = edgeKeyOf(x, y);
      edgeUse.set(ek, (edgeUse.get(ek) ?? 0) + 1);
    }
  };

  /** 外接球内是否还有别的点（空球判据） */
  const isEmptyBall = (a, b, c, cc) => {
    const limit = cc.radius * 0.95;
    let occupied = false;
    forEachNear(grid, positions, cc.ox, cc.oy, cc.oz, limit, (j) => {
      if (occupied || j === a || j === b || j === c) return;
      occupied = true;
    });
    return !occupied;
  };

  // k 近邻表（半径上限放宽到 1.3 倍球半径，随机采样下也能取到足够邻居）
  const near = new Array(n);
  for (let i = 0; i < n; i++) {
    const list = [];
    forEachNear(grid, positions, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], ballR * 1.3, (j, d2) => {
      if (j !== i) list.push({ j, d2 });
    });
    list.sort((p, q) => p.d2 - q.d2);
    near[i] = (list.length > k ? list.slice(0, k) : list).map((e) => e.j);
  }

  for (let i = 0; i < n; i++) {
    const list = near[i];
    for (let s = 0; s < list.length - 1; s++) {
      const a = list[s];
      const xa = positions[a * 3], ya = positions[a * 3 + 1], za = positions[a * 3 + 2];
      for (let t = s + 1; t < list.length; t++) {
        const b = list[t];
        // 只由编号最小的顶点生成该三角形，天然去重（省掉三角形去重表）
        if (a < i || b < i) continue;

        const dx = positions[b * 3] - xa;
        const dy = positions[b * 3 + 1] - ya;
        const dz = positions[b * 3 + 2] - za;
        if (dx * dx + dy * dy + dz * dz > maxEdge2) continue;

        if ((edgeUse.get(edgeKeyOf(i, a)) ?? 0) >= 2) continue;
        if ((edgeUse.get(edgeKeyOf(i, b)) ?? 0) >= 2) continue;
        if ((edgeUse.get(edgeKeyOf(a, b)) ?? 0) >= 2) continue;

        // 空球判据：外接球过大或球内有点，说明不是局部最贴合的三角形，剔除后不会重叠
        const cc = circumcircle(
          positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
          positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
          positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
        );
        if (!cc || cc.radius > ballR * 1.6) continue;
        if (!isEmptyBall(i, a, b, cc)) continue;

        // 法向贴合度校验，剔除跨壁面
        const cos = alignment(positions, normals, i, a, b, faceNormal(positions, i, a, b));
        if (Math.abs(cos) < 0.25) continue;

        addFace(...(cos > 0 ? [i, a, b] : [i, b, a]));
      }
    }
  }

  if (faces.length === 0) throw new Error('未能生成三角面，请调大球半径');
  const mesh = compact(positions, faces);
  return { positions: mesh.positions, indices: mesh.indices, triangles: faces.length };
}

/** 供面板使用的算法清单 */
export const RECON_METHODS = [
  { id: 'poisson', label: '泊松重建 Poisson' },
  { id: 'bpa', label: 'BPA 球旋转法' },
  { id: 'fast', label: '空球判据三角化（快速）' },
];
