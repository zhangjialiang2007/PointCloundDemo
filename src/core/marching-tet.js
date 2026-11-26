/**
 * 行进四面体（Marching Tetrahedra）等值面提取。
 * 相比 Marching Cubes 无查表歧义问题，代码量小，适合演示。
 *
 * 输出为「索引化」三角网格：交点按所在网格边的全局节点对去重，
 * 因此相邻体素的公共面共用同一批顶点，导出 / 后处理时拓扑连续。
 * 每个三角面的绕序按「内侧 → 外侧」定向，最后再用有符号体积统一整体朝向，
 * 保证所有面一致朝外（不依赖 χ 正负号的约定）。
 */

/** 立方体 8 个角点的局部偏移 */
const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

/** 立方体沿对角线 0-6 剖分为 6 个四面体 */
const TETS = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
];

// 单个四面体最多 4 个交点，复用缓冲避免每帧分配
const EDGE_I = new Int32Array(4);
const EDGE_J = new Int32Array(4);
const CROSS_V = new Int32Array(4);

/**
 * @param {Float32Array} field 标量场，尺寸 (R+1)³，索引 x + (R+1)*(y + (R+1)*z)
 * @param {number} R 分辨率
 * @param {number[]} origin 网格原点
 * @param {number} size 网格边长
 * @param {number} iso 等值面阈值
 * @returns {{positions: Float32Array, indices: Uint32Array, triangles: number}}
 */
export function marchingTetrahedra(field, R, origin, size, iso) {
  const dim = R + 1;
  const h = size / R;

  // 顶点坐标与面片索引；vertexMap 以「网格边两端全局节点下标」为键去重
  const ctx = {
    positions: [],
    indices: [],
    vertexMap: new Map(),
  };

  const corners = new Float64Array(24);
  const values = new Float64Array(8);
  const gids = new Int32Array(8); // 8 个角点在标量场中的全局下标

  for (let z = 0; z < R; z++) {
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        // ---- 取立方体 8 个角点 ----
        let insideMask = 0;
        for (let c = 0; c < 8; c++) {
          const ox = CORNERS[c][0];
          const oy = CORNERS[c][1];
          const oz = CORNERS[c][2];
          const gid = x + ox + dim * (y + oy + dim * (z + oz));
          gids[c] = gid;
          const v = field[gid];
          values[c] = v;
          if (v > iso) insideMask |= 1 << c;

          corners[c * 3] = origin[0] + (x + ox) * h;
          corners[c * 3 + 1] = origin[1] + (y + oy) * h;
          corners[c * 3 + 2] = origin[2] + (z + oz) * h;
        }

        // 整个体素在等值面同侧，跳过
        if (insideMask === 0 || insideMask === 255) continue;

        for (let t = 0; t < 6; t++) {
          emitTetra(ctx, values, corners, gids, TETS[t], iso);
        }
      }
    }
  }

  // ---- 统一整体朝向：闭合曲面的有符号体积为正即朝外 ----
  orientOutward(ctx.positions, ctx.indices);

  return {
    positions: new Float32Array(ctx.positions),
    indices: new Uint32Array(ctx.indices),
    triangles: ctx.indices.length / 3,
  };
}

/**
 * 处理单个四面体：根据 4 个顶点的内外状态生成 0~2 个三角形。
 * @param {object} ctx 输出上下文（顶点、索引、去重表）
 * @param {Float64Array} values 角点标量值
 * @param {Float64Array} corners 角点坐标
 * @param {Int32Array} gids 角点全局下标（用于共享边去重）
 * @param {number[]} tet 四面体的 4 个角点索引
 * @param {number} iso 等值面阈值
 */
function emitTetra(ctx, values, corners, gids, tet, iso) {
  const a = tet[0];
  const b = tet[1];
  const c = tet[2];
  const d = tet[3];

  const inA = values[a] > iso;
  const inB = values[b] > iso;
  const inC = values[c] > iso;
  const inD = values[d] > iso;
  const count = (inA ? 1 : 0) + (inB ? 1 : 0) + (inC ? 1 : 0) + (inD ? 1 : 0);
  if (count === 0 || count === 4) return;

  let n = 0;
  let lone = -1;
  let i0 = -1;
  let i1 = -1;
  let j0 = -1;
  let j1 = -1;

  if (count === 1 || count === 3) {
    // 单独一侧的顶点（1 个内部点或 1 个外部点），它与另外三个顶点构成 3 条跨越边
    lone = count === 1
      ? (inA ? a : inB ? b : inC ? c : d)
      : (!inA ? a : !inB ? b : !inC ? c : d);

    for (let k = 0; k < 4; k++) {
      const v = tet[k];
      if (v === lone) continue;
      EDGE_I[n] = lone;
      EDGE_J[n] = v;
      n++;
    }
  } else {
    // 2-2 情形：内部两点、外部两点，共 4 条跨越边
    const ins = [];
    const outs = [];
    for (let k = 0; k < 4; k++) {
      const v = tet[k];
      if (values[v] > iso) ins.push(v);
      else outs.push(v);
    }
    i0 = ins[0];
    i1 = ins[1];
    j0 = outs[0];
    j1 = outs[1];
    // 交叉四边形按 i0-j0 → i0-j1 → i1-j1 → i1-j0 排序，避免自相交
    EDGE_I[0] = i0; EDGE_J[0] = j0;
    EDGE_I[1] = i0; EDGE_J[1] = j1;
    EDGE_I[2] = i1; EDGE_J[2] = j1;
    EDGE_I[3] = i1; EDGE_J[3] = j0;
    n = 4;
  }

  // ---- 定向：四面体内标量场是线性的，其梯度就是等值面法向，方向精确 ----
  // 先求梯度，退化四面体直接跳过，避免产生孤立顶点
  if (!tetGradient(values, corners, tet)) return;
  const dx = GRAD[0];
  const dy = GRAD[1];
  const dz = GRAD[2];

  // ---- 生成（或复用）交点顶点，线性插值定位 ----
  for (let k = 0; k < n; k++) {
    const i = EDGE_I[k];
    const j = EDGE_J[k];
    const t = (iso - values[i]) / (values[j] - values[i]);
    CROSS_V[k] = crossingVertex(ctx, corners, gids, i, j, t);
  }

  if (n === 3) {
    pushTri(ctx, CROSS_V[0], CROSS_V[1], CROSS_V[2], dx, dy, dz);
  } else {
    pushTri(ctx, CROSS_V[0], CROSS_V[1], CROSS_V[2], dx, dy, dz);
    pushTri(ctx, CROSS_V[0], CROSS_V[2], CROSS_V[3], dx, dy, dz);
  }
}

// 四面体梯度输出缓冲
const GRAD = new Float64Array(3);

/**
 * 求四面体内线性标量场的梯度（Cramer 法则解 3×3 方程组）。
 * 梯度方向与等值面法向平行，用来给三角面定向。
 * @returns {boolean} 四面体退化（体积为 0）时返回 false
 */
function tetGradient(values, corners, tet) {
  const a = tet[0];
  const b = tet[1];
  const c = tet[2];
  const d = tet[3];

  const ax = corners[a * 3], ay = corners[a * 3 + 1], az = corners[a * 3 + 2];
  const d1x = corners[b * 3] - ax, d1y = corners[b * 3 + 1] - ay, d1z = corners[b * 3 + 2] - az;
  const d2x = corners[c * 3] - ax, d2y = corners[c * 3 + 1] - ay, d2z = corners[c * 3 + 2] - az;
  const d3x = corners[d * 3] - ax, d3y = corners[d * 3 + 1] - ay, d3z = corners[d * 3 + 2] - az;

  // 行列式按第一行展开的三组余子式
  const cx1 = d2y * d3z - d2z * d3y;
  const cx2 = d2x * d3z - d2z * d3x;
  const cx3 = d2x * d3y - d2y * d3x;
  const det = d1x * cx1 - d1y * cx2 + d1z * cx3;
  if (Math.abs(det) < 1e-20) return false;

  const b1 = values[b] - values[a];
  const b2 = values[c] - values[a];
  const b3 = values[d] - values[a];
  const inv = 1 / det;

  GRAD[0] = (b1 * cx1 - d1y * (b2 * d3z - b3 * d2z) + d1z * (b2 * d3y - b3 * d2y)) * inv;
  GRAD[1] = (d1x * (b2 * d3z - b3 * d2z) - b1 * cx2 + d1z * (d2x * b3 - d3x * b2)) * inv;
  GRAD[2] = (d1x * (d2y * b3 - d3y * b2) - d1y * (d2x * b3 - d3x * b2) + b1 * cx3) * inv;
  return true;
}

/**
 * 边 (i, j) 上的交点（同一条网格边只生成一个顶点）。
 * 相邻立方体共享同一条边，端点场值相同，插值参数 t 也相同，故可安全复用。
 */
function crossingVertex(ctx, corners, gids, i, j, t) {
  const gi = gids[i];
  const gj = gids[j];
  const key = gi < gj ? `${gi}_${gj}` : `${gj}_${gi}`;

  const cached = ctx.vertexMap.get(key);
  if (cached !== undefined) return cached;

  const id = ctx.positions.length / 3;
  ctx.positions.push(
    corners[i * 3] + t * (corners[j * 3] - corners[i * 3]),
    corners[i * 3 + 1] + t * (corners[j * 3 + 1] - corners[i * 3 + 1]),
    corners[i * 3 + 2] + t * (corners[j * 3 + 2] - corners[i * 3 + 2]),
  );
  ctx.vertexMap.set(key, id);
  return id;
}

/**
 * 按参考外法向写入一个三角形：面法向与参考方向相反时交换后两个顶点。
 */
function pushTri(ctx, ia, ib, ic, dx, dy, dz) {
  const p = ctx.positions;
  const ax = p[ia * 3], ay = p[ia * 3 + 1], az = p[ia * 3 + 2];
  const bx = p[ib * 3], by = p[ib * 3 + 1], bz = p[ib * 3 + 2];
  const cx = p[ic * 3], cy = p[ic * 3 + 1], cz = p[ic * 3 + 2];

  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;

  if (nx * dx + ny * dy + nz * dz < 0) {
    const tmp = ib;
    ib = ic;
    ic = tmp;
  }
  ctx.indices.push(ia, ib, ic);
}

/**
 * 用有符号体积统一整体朝向：闭合曲面体积为负说明全部朝内，整体翻转。
 * 以首个顶点为参考点计算，避免大坐标（BIM 坐标）下的数值抵消。
 */
function orientOutward(positions, indices) {
  if (indices.length < 3 || positions.length < 9) return;

  const rx = positions[0];
  const ry = positions[1];
  const rz = positions[2];
  let volume = 0;

  for (let f = 0; f < indices.length; f += 3) {
    const ai = indices[f] * 3;
    const bi = indices[f + 1] * 3;
    const ci = indices[f + 2] * 3;
    const ax = positions[ai] - rx, ay = positions[ai + 1] - ry, az = positions[ai + 2] - rz;
    const bx = positions[bi] - rx, by = positions[bi + 1] - ry, bz = positions[bi + 2] - rz;
    const cx = positions[ci] - rx, cy = positions[ci + 1] - ry, cz = positions[ci + 2] - rz;
    volume +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }

  if (volume >= 0) return;
  for (let f = 0; f < indices.length; f += 3) {
    const tmp = indices[f + 1];
    indices[f + 1] = indices[f + 2];
    indices[f + 2] = tmp;
  }
}
