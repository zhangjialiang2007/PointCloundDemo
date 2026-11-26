import { poissonReconstruct } from '../src/core/poisson.js';
import { computeFaceAreas, buildEdgeFaces } from '../src/core/mesh.js';

function sphere(n, radius, cx, cy, cz) {
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    const x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    positions[i * 3] = cx + x * radius;
    positions[i * 3 + 1] = cy + y * radius;
    positions[i * 3 + 2] = cz + z * radius;
    normals[i * 3] = x;
    normals[i * 3 + 1] = y;
    normals[i * 3 + 2] = z;
  }
  return { positions, normals };
}

const P = sphere(4000, 1, 5000, 3000, 1000);
const { positions, indices } = poissonReconstruct(P.positions, P.normals, { resolution: 40 });
const F = indices.length / 3;
const areas = Float64Array.from(computeFaceAreas(positions, indices));
let sum = 0;
for (let f = 0; f < F; f++) sum += areas[f];
const avg = sum / F;
const sorted = Float64Array.from(areas).sort();
const q = (p) => sorted[Math.floor((sorted.length - 1) * p)];

for (const r of [2e-2, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6]) {
  let n = 0;
  for (let f = 0; f < F; f++) if (areas[f] < avg * r) n++;
  console.log(`areaRatio ${r}: 退化面 ${n}`);
}
console.log(`面积分位 p0=${q(0)} p1e-4=${q(1e-4).toExponential(2)} p1e-3=${q(1e-3).toExponential(2)} p1e-2=${q(0.01).toExponential(2)} p50=${q(0.5).toExponential(2)} avg=${avg.toExponential(2)}`);

function components(idx) {
  const edges = buildEdgeFaces(idx);
  const seen = new Uint8Array(idx.length / 3);
  let c = 0;
  for (let s = 0; s < idx.length / 3; s++) {
    if (seen[s]) continue;
    c++;
    seen[s] = 1;
    const st = [s];
    while (st.length) {
      const f = st.pop();
      for (let k = 0; k < 3; k++) {
        const a = idx[f * 3 + k];
        const b = idx[f * 3 + ((k + 1) % 3)];
        const rec = edges.get(a < b ? `${a}_${b}` : `${b}_${a}`);
        if (!rec) continue;
        for (const nf of rec.faces) if (!seen[nf]) { seen[nf] = 1; st.push(nf); }
      }
    }
  }
  return c;
}
function boundary(idx) {
  const edges = buildEdgeFaces(idx);
  let b = 0;
  for (const rec of edges.values()) if (rec.faces.length === 1) b++;
  return b;
}
for (const r of [1e-2, 1e-3, 1e-4, 1e-5]) {
  const out = [];
  for (let f = 0; f < F; f++) if (areas[f] >= avg * r) out.push(indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]);
  const idx = new Uint32Array(out);
  console.log(`areaRatio ${r}: 剩余面 ${idx.length / 3} 边界边 ${boundary(idx)} 连通分量 ${components(idx)}`);
}
