/**
 * 行进四面体（Marching Tetrahedra）等值面提取。
 * 相比 Marching Cubes 无查表歧义问题，代码量小，适合演示。
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

/**
 * @param {Float32Array} field 标量场，尺寸 (R+1)³，索引 x + (R+1)*(y + (R+1)*z)
 * @param {number} R 分辨率
 * @param {number[]} origin 网格原点
 * @param {number} size 网格边长
 * @param {number} iso 等值面阈值
 * @returns {{positions: Float32Array, triangles: number}}
 */
export function marchingTetrahedra(field, R, origin, size, iso) {
  const dim = R + 1;
  const h = size / R;
  const out = []; // 非索引三角形顶点

  const corners = new Float64Array(24);
  const values = new Float64Array(8);
  const crossings = new Float64Array(12); // 最多 4 个交点

  for (let z = 0; z < R; z++) {
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        // ---- 取立方体 8 个角点 ----
        let insideMask = 0;
        for (let c = 0; c < 8; c++) {
          const ox = CORNERS[c][0];
          const oy = CORNERS[c][1];
          const oz = CORNERS[c][2];
          const v = field[x + ox + dim * (y + oy + dim * (z + oz))];
          values[c] = v;
          if (v > iso) insideMask |= 1 << c;

          corners[c * 3] = origin[0] + (x + ox) * h;
          corners[c * 3 + 1] = origin[1] + (y + oy) * h;
          corners[c * 3 + 2] = origin[2] + (z + oz) * h;
        }

        // 整个体素在等值面同侧，跳过
        if (insideMask === 0 || insideMask === 255) continue;

        for (let t = 0; t < 6; t++) {
          emitTetra(out, values, corners, TETS[t], iso, crossings);
        }
      }
    }
  }

  return { positions: new Float32Array(out), triangles: out.length / 9 };
}

/**
 * 处理单个四面体：根据 4 个顶点的内外状态生成 0~2 个三角形。
 * @param {number[]} out 输出顶点数组
 * @param {Float64Array} values 角点标量值
 * @param {Float64Array} corners 角点坐标
 * @param {number[]} tet 四面体的 4 个角点索引
 */
function emitTetra(out, values, corners, tet, iso, crossings) {
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

  let edgeCount = 0;
  let i0, j0, i1, j1; // 用于 2-2 情形

  if (count === 1 || count === 3) {
    // 单独一侧的顶点（1 个内部点或 1 个外部点），它与另外三个顶点构成 3 条跨越边
    const lone = count === 1
      ? (inA ? a : inB ? b : inC ? c : d)
      : (!inA ? a : !inB ? b : !inC ? c : d);

    const others = [a, b, c, d].filter((v) => v !== lone);
    for (const o of others) {
      writeCrossing(crossings, edgeCount++, values, corners, lone, o, iso);
    }
  } else {
    // 2-2 情形：内部两点、外部两点，共 4 条跨越边
    const ins = [];
    const outs = [];
    for (const v of [a, b, c, d]) {
      if (values[v] > iso) ins.push(v);
      else outs.push(v);
    }
    i0 = ins[0];
    i1 = ins[1];
    j0 = outs[0];
    j1 = outs[1];
    // 交叉四边形按 i0-j0 → i0-j1 → i1-j1 → i1-j0 排序，避免自相交
    writeCrossing(crossings, 0, values, corners, i0, j0, iso);
    writeCrossing(crossings, 1, values, corners, i0, j1, iso);
    writeCrossing(crossings, 2, values, corners, i1, j1, iso);
    writeCrossing(crossings, 3, values, corners, i1, j0, iso);
    edgeCount = 4;
  }

  if (edgeCount === 3) {
    pushVertex(out, crossings, 0);
    pushVertex(out, crossings, 1);
    pushVertex(out, crossings, 2);
  } else if (edgeCount === 4) {
    pushVertex(out, crossings, 0);
    pushVertex(out, crossings, 1);
    pushVertex(out, crossings, 2);

    pushVertex(out, crossings, 0);
    pushVertex(out, crossings, 2);
    pushVertex(out, crossings, 3);
  }
}

/** 线性插值求边 i-j 与等值面的交点，写入 crossings[slot] */
function writeCrossing(crossings, slot, values, corners, i, j, iso) {
  const vi = values[i];
  const vj = values[j];
  const t = (iso - vi) / (vj - vi); // vi、vj 分居等值面两侧，分母不会为 0
  const o = slot * 3;
  crossings[o] = corners[i * 3] + t * (corners[j * 3] - corners[i * 3]);
  crossings[o + 1] = corners[i * 3 + 1] + t * (corners[j * 3 + 1] - corners[i * 3 + 1]);
  crossings[o + 2] = corners[i * 3 + 2] + t * (corners[j * 3 + 2] - corners[i * 3 + 2]);
}

/** 把第 slot 个交点写入输出数组 */
function pushVertex(out, crossings, slot) {
  const o = slot * 3;
  out.push(crossings[o], crossings[o + 1], crossings[o + 2]);
}
